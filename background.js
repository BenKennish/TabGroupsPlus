// ===========================================================================
// Tab Groups Plus (TGP)
// service worker (background.js)
// ===========================================================================

// see GitHub issues for official TODOs and known bugs:
// https://github.com/BenKennish/TabGroupsPlus/issues

// NOTE: we deliberately do not pass around Tab objects but use tabIds because tab objects are snapshots
// (i.e. they are not updated when the tabs are updated elsewhere)


import { ALIGN, DEFAULT_OPTIONS, CONSOLE_PREFIX, AUTO_GROUP_PATTERN_TYPE } from './shared.js';

// timeout (ms) for receiving the browser's onStartup event
// if we receive this in time, we know to wait longer for initialisation of windows, tabs, and groups
const ON_STARTUP_WAIT_TIMEOUT_MS = 3000;

// time to wait (ms) before listening for events if the browser is starting up
// (we allow time for it to create windows, tabs, etc when restoring previous session)
// must be greater than ON_STARTUP_WAIT_TIMEOUT_MS
const LISTEN_DELAY_ON_BROWSER_STARTUP_MS = 10000;

// time to wait after a new tab is created before checking its group
// (the reason for this is that the browser may have plans to move the tab
// into a group automatically very shortly after its creation)
const CHECK_GROUPING_DELAY_ON_CREATE_TAB_MS = 250;

// enable/disable console.debug() messages
// yes, the user can filter these out of the console if they want, but this allows cutting them out for performance reasons
const SHOW_DEBUG_CONSOLE_MSGS = true;

// setting to true requires setting "host_permissions" in manifest.json and adding the "scripting" permission
// and then uncommenting further code below
const DYNAMIC_INJECTS = false;

// used to store user options (retrieved from Chrome's sync storage)
let userOptions = {};

// when a new tab is created, we store the ID in here
// and we remove it when the tab starts loading its first URL
// this is used to track
const tabsAwaitingFirstUrl = new Set();

// maps window ID to an object about that window (see newWindowDataObj below)
// don't touch this directly - use getWindowData() to access it
// and call saveWindowData() to save it back to local storage
//
// FIXME: this should probably all be encapsulated in an object or something
let globalWindowDataMap = new Map();

// example of data structure within globalWindowDataMap
// this is used as a template/'constructor' for new window data objects
const newWindowDataObj = {

    // ID of the group that was active during the last compactGroups() call
    // will have been moved leftmost/rightmost if alignActiveTabGroup !== ALIGN.DISABLED
    groupActiveDuringLastCompactId: chrome.tabGroups.TAB_GROUP_ID_NONE,
    // previously groupLastMovedDuringCompactId

    // the group position index (NOT tab index) the group used to have before it was activated, and moved by compactGroups()
    groupActiveDuringLastCompactPrevPos: null,
    // previously groupLastMovedDuringCompactPrevPos

    // ID of last active tab, used when a new tab is created (and made active) so that we
    // can add it to the group of this last active tab
    lastActiveTabId: null,

    // gets set to the ID of a newly created tab so that onActivate and onCreate don't stomp on each other
    newTabId: null,

    // setTimeout timer object for the compact operation gets stored here
    // so that it can be cancelled if necessary
    compactTimer: null
};



// ============================================================================
// ============================================================================
// ============================================================================



// given an enum object and a value, return the name of the enum member with that value, or null if not found
//
function enumValueToName(value, enumObj)
{
    for (const [key, val] of Object.entries(enumObj))
    {
        if (val === value)
        {
            return key;
        }
    }
    return null;
}



// given an enum object and a value, return true if the value is a valid member of the enum, false otherwise
//
function isValidEnumValue(value, enumObj)
{
    return Object.values(enumObj).includes(value);
}



// return an array of tab groups in a window in the left-to-right display order
// excluding any group with ID `excludeId`
// if `excludeId` is chrome.tabGroups.TAB_GROUP_ID_NONE, don't exclude any group
//
async function getTabGroupsOrdered(windowId, excludeId)
{
    console.debug(`${CONSOLE_PREFIX} Running getTabGroupsOrdered(${windowId}, ${excludeId})`);

    // grab all the tabs in the window (will be sorted by left -> right position)
    let tabs;

    try
    {
        tabs = await chrome.tabs.query({ windowId: windowId });
    }
    catch (err)
    {
        // err will be the chrome.runtime.lastError object
        throw err;
    }

    const groupIdsOrdered = [];
    let lastSeenGroupId = chrome.tabGroups.TAB_GROUP_ID_NONE;

    tabs.forEach((tab) =>
    {
        if (tab.groupId === chrome.tabGroups.TAB_GROUP_ID_NONE ||
            tab.groupId === lastSeenGroupId)
        {
            // ignore ungrouped tabs and those
            // in the same group as the previously examined tab
            return;
        }

        // at this point, 'tab' is the first tab in a newly seen group...

        if (tab.groupId !== excludeId)
        {
            // this tab is not in the excluded group (the group that contains the window's active tab)
            // push this group ID to the list
            groupIdsOrdered.push(tab.groupId);
        }
        lastSeenGroupId = tab.groupId;
    });

    // create array of promises to retrieve each tab group, in same order as in groupIdsOrdered
    // creates a list of Promises that retrieve each specific tab group
    const getGroupPromises = groupIdsOrdered.map(groupId => chrome.tabGroups.get(groupId));

    // create a promise that resolves when all the groups have been retrieved
    try
    {
        let groups = await Promise.all(getGroupPromises);
        // groups is now a list of tab group objects
        // possible in incorrect order

        // TODO: i think ChatGPT might have overengineered this because Promise.all()
        // should return the results in the same order as the input iterable anyway? right?

        // create a new list of these retrieved groups but in the same order as the IDs given in groupIdsOrdered
        const groupsOrdered = groupIdsOrdered.map(
            id => groups.find(group => group.id === id)
        );
        return groupsOrdered;
    }
    catch (error)
    {
        throw error;
    }

}



// retrieve data for a window, creating a new entry in the Map if necessary
// if we are configured to align the active tab group, sensible defaults are filled in, but asynchronously)
//
function getWindowData(windowId, forceNew = false)
{
    try
    {
        if (forceNew || !globalWindowDataMap.has(windowId))
        {
            // initialise a new windowData object for this window
            // using spread operator to create a shallow copy of the newWindowDataObj template object and only its enumerable (non-inherited) properties
            const thisWindowData = { ...newWindowDataObj };
            globalWindowDataMap.set(windowId, thisWindowData);

            if (userOptions.alignActiveTabGroup !== ALIGN.DISABLED)
            {
                // we are set to align the active tab group so
                // we need to create sensible default assumptions for groupActiveDuringLastCompactId and lastMovedGroupPrevPos

                // this initialisation is done asynchronously because we can populate it later and its not a tragedy if it's not populated at all
                // also note we are modifying the object pointed to by thisWindowData which is the same object that is in globalWindowDataMap

                getTabGroupsOrdered(windowId, chrome.tabGroups.TAB_GROUP_ID_NONE)
                    .then((groupsOrdered) =>
                    {
                        switch (userOptions.alignActiveTabGroup)
                        {
                            case ALIGN.LEFT:
                                // pretend that the leftmost tabgroup (might be active, might not) was the one that was aligned left in the last compact operation
                                // and that it was previously in group index position 0 (leftmost)
                                thisWindowData.groupActiveDuringLastCompactId = groupsOrdered.length > 0 ? groupsOrdered[0].id : chrome.tabGroups.TAB_GROUP_ID_NONE;
                                thisWindowData.lastMovedGroupPrevPos = 0;
                                break;

                            case ALIGN.RIGHT:
                                // pretend the rightmost tabgroup (might be active, might not) was the one aligned right in the last compact operation
                                // and that it was previously in the largest group index position (rightmost)
                                thisWindowData.groupActiveDuringLastCompactId = groupsOrdered.length > 0 ? groupsOrdered[groupsOrdered.length - 1].id : chrome.tabGroups.TAB_GROUP_ID_NONE;
                                thisWindowData.lastMovedGroupPrevPos = groupsOrdered.length - 1;
                                break;
                        }
                        console.log(`${CONSOLE_PREFIX} Initialized windowData entry for window ${windowId}`);

                    },
                        (err) =>
                        {
                            console.error(`Error retrieving ordered tab groups in getWindowData() when setting default data for window ${windowId}:`, err);
                        });

            }

        }
        return globalWindowDataMap.get(windowId);
    }
    catch (err)
    {
        console.error(`${CONSOLE_PREFIX} getWindowData failed:`, err);
        throw err;
    }
}



// save the globalWindowDataMap to local storage
// doesn't guarantee that the data is actually saved before the function returns,
// but does guarantee that the save operation has been initiated and any errors will be logged to the console
//
function saveWindowData()
{
    // globalWindowDataMap is a Map of objects
    // we store it into chrome.storage.local as an array of arrays which contain winId and the corresonding plain objects for that window (no methods)

    // Convert each element back to a plain object...
    // .entries() of an object returns an iterator of the key-value pairs  [ ['name', 'Ben'], ['age', 43] ... ]
    // Array.from() turns this into a proper array so we can use .map()
    // we then map it onto a new array

    const winDataProperties = Array.from(globalWindowDataMap.entries()).map(([winId, winData]) =>
    {
        // we strip out the compactTimer property before saving because it's transient and we don't need it to persist across sessions
        // we do this using destructuring and "the rest ..." syntax
        const { compactTimer, ...winDataToSave } = winData

        // winData is a plain object based on newWindowDataObj
        // all of it's enumerable properties (those directly defined on it and not inherited from its prototype)
        // are non-function properties (i.e. not "methods")
        // so when we use the spread operator (...), (same '...' symbol as 'rest' above) and a new object is created
        // it contains only these non-function enumerable properties
        return [winId, { ...winDataToSave }];
    });


    // we don't use await here as it's unlikely to fail and we don't need to wait for it to complete before doing anything else
    chrome.storage.local.set({ windowData: winDataProperties })
        .then(() =>
        {
            console.debug(CONSOLE_PREFIX + ' windowData saved to local storage:', winDataProperties);
        })
        .catch((err) =>
        {
            console.error(`${CONSOLE_PREFIX} Failed to save windowData to local storage:`, err);
        });

}



// check if our content script has been injected into the tab with id `tabId`
// content script cannot inject into certain content, e.g. "about:blank", Google Web Store, browser settings, etc
// returns true if the content script responds to a ping, false otherwise
//
async function isContentScriptActive(tabId)
{
    try
    {
        let response = await chrome.tabs.sendMessage(tabId, { action: "ping" });
        console.debug('Content script replied to ping with : ', response);

        if (response.status && response.status === "pong")
        {
            return true;
        }
        else
        {
            console.warn('Content script replied to ping BUT with unexpected response: ', response)
        }
        return false;
    }
    catch (err)
    {
        console.debug('Failed to ping content script:', err);
        return false;
    }
}



// cancel any action timers set for the supplied window ID
//
function cancelCompactTimer(windowId)
{
    let thisWindowData = getWindowData(windowId);

    if (thisWindowData.compactTimer)
    {
        clearTimeout(thisWindowData.compactTimer);
        thisWindowData.compactTimer = null;

        console.debug(`${CONSOLE_PREFIX} Cleared compact timer for window:`, windowId);
    }
}



// get the tab index of the first tab in a group
//
async function getIndexOfFirstTabInGroup(group)
{
    try
    {
        // Query all tabs in the specified group
        const tabs = await chrome.tabs.query({ groupId: group.id });

        if (tabs.length === 0)
        {
            // should be impossible
            console.error(`${CONSOLE_PREFIX} Group (titled '${group.title}') has NO TABS!?`, group);
            throw Error(`Group (titled '${group.title}') has no tabs!`);
        }

        // Find the tab with the smallest index
        const firstTab = tabs.reduce((minTab, currentTab) =>
        {
            return (currentTab.index < minTab.index) ? currentTab : minTab;
        });

        return firstTab.index;
    }
    catch (error)
    {
        console.error(`${CONSOLE_PREFIX} Error getting index of first tab in group:`, error);
        throw error;
    }
}



//  get the number of tabs in a group
//
async function countTabsInGroup(groupId)
{
    try
    {
        const tabs = await chrome.tabs.query({ groupId: groupId });
        return tabs.length;
    }
    catch (error)
    {
        console.error(`${CONSOLE_PREFIX} Error counting tabs in group:`, error);
        throw error;
    }
}



// collapse all tab groups in a window except the one with group ID `excludeGroupId`
// (if you want to collapse all groups, pass chrome.tabGroups.TAB_GROUP_ID_NONE for excludeGroupId)
//
async function collapseTabGroupsInWindow(windowId, excludeGroupId)
{
    let groups;

    try
    {
        groups = await chrome.tabGroups.query({ windowId: windowId, collapsed: false });
    }
    catch (err)
    {
        console.error(`${CONSOLE_PREFIX} Failed to query tabs of window ${activeTab.windowId}`, err);
        throw err;
    }

    let groupIds = groups.map(group => group.id);

    if (excludeGroupId !== chrome.tabGroups.TAB_GROUP_ID_NONE)
    {
        // filter out the excluded group ID
        // could we do it one step at the same time as the map() above?
        groupIds = groupIds.filter(id => id !== excludeGroupId);
    }

    try
    {
        const collapseGroupPromises = groupIds.map(groupId => chrome.tabGroups.update(groupId, { collapsed: true }));
        // an array of promises to collapse each uncollapsed group in the window

        await Promise.all(collapseGroupPromises);
    }
    catch (err)
    {
        // one or more collapse operations failed
        console.error(`${CONSOLE_PREFIX} Failed to collapse one or more groups in window ${windowId}`, err);
        throw new Error(`Failed to collapse one or more groups in window ${windowId}: ${err}`);
    }

}



// collapse all the inactive groups of the window containing the given active tab
//
async function collapseInactiveGroups(activeTab)
{
    // don't collapse the active tab's group (could be TAB_GROUP_ID_NONE if the active tab is ungrouped)
    let groupNotToCollapseId = activeTab.groupId;

    // OR if the active tab is ungrouped and we are set not to collapse the previously active group after activating an ungrouped tab
    if (activeTab.groupId === chrome.tabGroups.TAB_GROUP_ID_NONE &&
        userOptions.collapsePreviousActiveGroupOnActivateUngroupedTab === false)
    {
        // we don't collapse the group that was active during the last compact
        groupNotToCollapseId = (getWindowData(activeTab.windowId)).groupActiveDuringLastCompactId;
    }

    try
    {
        await collapseTabGroupsInWindow(activeTab.windowId, groupNotToCollapseId);
    }
    catch (err)
    {
        console.error(CONSOLE_PREFIX + " Failed to collapse inactive groups", err);
        // we don't throw, just continue...
    };

}



// restore the position of the group that was active during the last compact operation (the previously active group)
// if it still exists and if we have a record of its previous position
// (could be called restorePositionOfPreviouslyActiveGroup() - because we would only be calling this function if the align setting is enabled )
//
// windowId : id of the window we're compacting
// thisWindowData : the data object for this window
//
async function restorePositionOfGroupActiveDuringLastCompact(windowId)
{
    const thisWindowData = getWindowData(windowId)

    try
    {
        let groupActiveDuringLastCompact = await chrome.tabGroups.get(thisWindowData.groupActiveDuringLastCompactId);

        console.log(`${CONSOLE_PREFIX} Group moved during last compact op (previously at group pos index ${thisWindowData.groupActiveDuringLastCompactPrevPos}):`, groupActiveDuringLastCompact);

        // retrieve ALL tab groups in this window in left-to-right order
        try
        {
            const groupsOrdered = await getTabGroupsOrdered(windowId, chrome.tabGroups.TAB_GROUP_ID_NONE);

            console.log(`${CONSOLE_PREFIX} All tab groups in window ${windowId} in left-to-right order:`, groupsOrdered);

            // hard to explain why this works but it does - magic!
            // i guess we want the group to be to the right of any group in this old position
            thisWindowData.groupActiveDuringLastCompactPrevPos++;

            let tabIndexToMoveTo = ALIGN.RIGHT;

            // retrive the tab group that's currently occupying the group pos index where the previously active group was
            if (groupsOrdered[thisWindowData.groupActiveDuringLastCompactPrevPos])
            {
                // there's a group located in the group index pos where we want to return this group
                // this group will be bumped one place to the right after the move

                console.log(`${CONSOLE_PREFIX} Group currently at group pos ${thisWindowData.groupActiveDuringLastCompactPrevPos}:`, groupsOrdered[thisWindowData.groupActiveDuringLastCompactPrevPos]);

                // fetch the tab index of the first tab of the group that's currently at this group index position
                tabIndexToMoveTo = await getIndexOfFirstTabInGroup(groupsOrdered[thisWindowData.groupActiveDuringLastCompactPrevPos]);

                console.debug(`${CONSOLE_PREFIX} Leftmost tab of group currently at the old position of the group active during last compact has index`, tabIndexToMoveTo);
            }
            else
            {
                // there's no group at this group index - so there are fewer groups than before
                // this might happen if the user has closed some groups or moved them into a different window
                // all we can do is tack this group on to the end
                console.log(CONSOLE_PREFIX + " No group currently at this group's previous location.  Moving to rightmost position.");
            }

            /*
            chrome.tabGroups.move() is defined like this:
            "After moving, the first tab in the tab group is at this index in the tab strip"
                 sooooo
            if we're moving a tab group to the right of its current position,
            we need to set the target index location while IGNORING all tabs in the group being moved

            imagine tab indexing like this:

            INDEX:  0   1   2   3  4  5   6   7  8   9
            TAB  :  A1  A2  A3  1  2  B1  B2  3  C1  C2
               where 'B2' represents group B, tab 2
               and '3' represents the 3rd ungrouped tab

            imagine we are trying to move group B to the position where group C currently is
            we don't .move() it to index 8 because that's only 8 when our tabs (B1 and B2) are positioned where they are

            we effectively need to ignore the tabs of group B which means we look at it like this
            INDEX:  0   1   2   3  4  5  6   7   8   9
            TAB  :  A1  A2  A3  1  2  3  C1  C2

            and we must move B to index 6 which results in this ...

            INDEX:  0   1   2   3  4  5  6   7   8   9
            TAB  :  A1  A2  A3  1  2  3  B1  B2  C1  C2

            TLDR; subtract a group's number of tabs from the index if trying to move the tab group to the right
            */

            if (null !== tabIndexToMoveTo)  // proper null test necesary, tabIndexToMoveTo could be 0 and be valid
            {

                // get the tab index of the first tab in the group we're moving
                let currentTabIndex = await getIndexOfFirstTabInGroup(groupActiveDuringLastCompact);

                // if we are moving the group to the right of its current position
                if (tabIndexToMoveTo > currentTabIndex)
                {
                    // subtract the number of tabs in this group from the index
                    let numTabsInGroup = await countTabsInGroup(groupActiveDuringLastCompact.id);
                    tabIndexToMoveTo -= numTabsInGroup;
                    console.debug(`${CONSOLE_PREFIX} Adjusted target tab index to ${tabIndexToMoveTo} - subtracted ${numTabsInGroup} (tabs in the group to move)`);
                }

                console.log(`${CONSOLE_PREFIX} Moving previously active group ${groupActiveDuringLastCompact.title} to tab index ${tabIndexToMoveTo}...`);

                try
                {
                    await chrome.tabGroups.move(groupActiveDuringLastCompact.id, { index: tabIndexToMoveTo });
                }
                catch (err)
                {
                    console.error(`${CONSOLE_PREFIX} Failed restoring previously active group ${groupActiveDuringLastCompact.title} to tab index ${tabIndexToMoveTo}:`, err);
                    // we continue...
                }

            }
        }
        catch (err)
        {
            console.error(`${CONSOLE_PREFIX} Failed to retrieve ordered tab groups in window ${windowId}`, err);
        }
    }
    catch (err)
    {
        console.warn(`${CONSOLE_PREFIX} Failed to retrieve previously active group with ID ${thisWindowData.groupActiveDuringLastCompactId}.  Perhaps it was closed?`, err);
        groupActiveDuringLastCompact = null;
    }
}



// align all the ungrouped tabs in a window to the left/right of all the groups, preserving their current order relative to each other
//
async function alignUngroupedTabs(windowId, alignment = ALIGN.RIGHT)
{
    if (!isValidEnumValue(alignment, ALIGN))
    {
        console.error(CONSOLE_PREFIX + ' Unexpected value for alignment in call to alignUngroupedTabs(): ', alignment);
        throw new Error('Unexpected value for alignment in call to alignUngroupedTabs(): ' + alignment);
    }

    let ungroupedTabs;

    try
    {
        // grab all the ungrouped tabs in the window (this will be sorted by left->right position, chrome.tabs.query contract)
        ungroupedTabs = await chrome.tabs.query({ windowId: windowId, groupId: chrome.tabGroups.TAB_GROUP_ID_NONE });
    }
    catch (err)
    {
        console.error(CONSOLE_PREFIX + " Error retrieving ungrouped tabs in alignUngroupedTabs()", err);
        throw err;
    }

    if (alignment === ALIGN.LEFT)
    {
        // if aligning left, we want to start moving tabs starting from the rightmost ungrouped tab
        // (rather than the leftmost) so as to preserve their order
        ungroupedTabs.reverse();
    }

    // NOTE: if we're moving tabs to the far right (TODO: insert Hitler joke)
    // we are starting with the leftmost tab, and as a result we preserve their order

    for (let i = 0; i < ungroupedTabs.length; i++)
    {
        const ungroupedTab = ungroupedTabs[i];

        try
        {
            await chrome.tabs.move(ungroupedTab.id, { index: alignment });
        }
        catch (err)
        {
            console.error(`Failed to move ungrouped tab ${ungroupedTab.id}`, err);
            throw err;
        }
    };

}




// "compact" all the groups in a window - the main action of this extension
//  - collapses all groups except the active one, and optionally move the active group to the leftmost or rightmost position
// `activeTab` represents the current active tab of the window (or at least it should be active!)
//
async function compactGroups(activeTab)
{
    console.log(CONSOLE_PREFIX + " >>>> compactGroups() running for window " + activeTab.windowId + ", active tab is:", activeTab);

    // START sanity checks
    if (activeTab.active === false)
    {
        console.warn(CONSOLE_PREFIX + " compactGroups() called with a non-active tab!", activeTab);
        // presumably the tab has been deactivated since the scheduleCompactOtherGroups()
        //throw new Error("compactGroups() called with an inactive tab!");
        return
    }

    if (!isValidEnumValue(userOptions.alignActiveTabGroup, ALIGN))
    {
        console.error(CONSOLE_PREFIX + ' Unexpected value for alignActiveTabGroup', userOptions.alignActiveTabGroup);
        throw new Error('Unexpected value for alignActiveTabGroup: ' + userOptions.alignActiveTabGroup);
    }
    // END sanity checks

    // FIXME: we are passing this around quite a lot which seems problematic
    const thisWindowData = getWindowData(activeTab.windowId);

    // ==================================================================
    // (A) collapse all the inactive groups
    // ==================================================================
    console.log(CONSOLE_PREFIX + " ==== (A) Collapsing inactive groups...");
    await collapseInactiveGroups(activeTab);

    // we've now collapsed (or tried to collapse) all the groups except the active one
    // if the active group hasn't changed since last compact, we can return now
    // NB: we still do step A on a tab change within the same group to tidy up any user-expanded groups
    if (activeTab.groupId === thisWindowData.groupActiveDuringLastCompactId)
    {
        console.debug(CONSOLE_PREFIX + " Active tab's group was active during last compact.  All done");
        return;
    }


    if (activeTab.groupId === chrome.tabGroups.TAB_GROUP_ID_NONE &&
        userOptions.collapsePreviousActiveGroupOnActivateUngroupedTab === false
    )
    {
        console.log(`${CONSOLE_PREFIX} Active tab is ungrouped and we are set to not collapse the last active group open. All done`);
        return;
    }
    // NB: if the active tab is ungrouped but we ARE set to collapse the previously active group,
    // we continue to step B because we have collapsed the previously active group in step A and need to move it back to its previous position


    if (userOptions.alignActiveTabGroup !== ALIGN.DISABLED)
    {
        // we now run B, C, and D

        // ==================================================================
        // (B) restore the position of the *previously* active group (if there is one)
        // ==================================================================
        console.log(CONSOLE_PREFIX + " ==== (B) Restoring position of previously active group (that was moved during previous compact)...");

        console.debug(CONSOLE_PREFIX + " groupActiveDuringLastCompactId:", thisWindowData.groupActiveDuringLastCompactId);
        console.debug(CONSOLE_PREFIX + " groupActiveDuringLastCompactPrevPos:", thisWindowData.groupActiveDuringLastCompactPrevPos);

        // if there's a record of a group that was active during the last compact, and of its previous position
        if (thisWindowData.groupActiveDuringLastCompactPrevPos !== null &&
            thisWindowData.groupActiveDuringLastCompactId !== chrome.tabGroups.TAB_GROUP_ID_NONE)
        {
            // try to move it back to this position before moving the new active group to the leftmost/rightmost position in step D
            await restorePositionOfGroupActiveDuringLastCompact(activeTab.windowId, thisWindowData);
        }

        // -----------------------------------------------------

        // we've now returned (or failed to return) the previously active group
        // into the correct place so we clear the record

        thisWindowData.groupActiveDuringLastCompactId = chrome.tabGroups.TAB_GROUP_ID_NONE;
        thisWindowData.groupActiveDuringLastCompactPrevPos = null;

        // if the active tab is ungrouped
        if (activeTab.groupId === chrome.tabGroups.TAB_GROUP_ID_NONE)
        {
            // the values we set just above are therefore correct
            // and all groups are inactive and collapsed
            // (except last group if collapsePreviousActiveGroupOnActivateUngroupedTab is false)
            console.debug(`${CONSOLE_PREFIX} Active tab is ungrouped.  All done`);
            saveWindowData();
            return;
        }


        // ============================================================================================
        // (C) update the windowData object with new active group's info (before it's moved in step D)
        // ============================================================================================
        // NOTE: after this step, the "LastCompact" refers to THIS current compact operation

        console.log(CONSOLE_PREFIX + " ==== (C) Updating windowData object...");

        // refetch ordered list of all tab groups (after the move)
        try
        {
            thisWindowData.groupActiveDuringLastCompactId = activeTab.groupId;

            // calculate and store group pos index of the active group (before it is moved to leftmost/rightmost)
            const groupsOrdered = await getTabGroupsOrdered(activeTab.windowId, chrome.tabGroups.TAB_GROUP_ID_NONE);
            thisWindowData.groupActiveDuringLastCompactPrevPos = groupsOrdered.findIndex((group) =>
            {
                return group && group.id === activeTab.groupId;
            });

        }
        catch (err)
        {
            console.error(`${CONSOLE_PREFIX} Failed to retrieve ordered tab groups in window ${activeTab.windowId}.  Resetting windowData`, err);
            thisWindowData.groupActiveDuringLastCompactId = chrome.tabGroups.TAB_GROUP_ID_NONE;
            thisWindowData.groupActiveDuringLastCompactPrevPos = null;
            // we don't throw, just continue...
        }

        console.debug(`${CONSOLE_PREFIX} Updated windowData after step (C):`, thisWindowData);
        saveWindowData();


        // ==================================================================
        // (D) position the new active `group` to the very left or very right
        // ==================================================================
        console.log(`${CONSOLE_PREFIX} ==== (D) Aliging active group to ${userOptions.alignActiveTabGroup === ALIGN.LEFT ? "leftmost" : "rightmost"}...`);

        try
        {
            // the constants in ALIGN are set LEFT (0) and RIGHT (-1) so we can just give alignActiveTabGroup directly as the index to move to
            await chrome.tabGroups.move(activeTab.groupId, { index: userOptions.alignActiveTabGroup });
        }
        catch (err)
        {
            console.error(`${CONSOLE_PREFIX} Failed to align active group ${activeTab.groupId}:`, err);
            throw err;
        }
    }
    else
    {
        // alignActiveTabGroup is ALIGN.DISABLED

        // we set groupActiveDuringLastCompactId so that
        // if collapsePreviousActiveGroupOnActivateUngroupedTab is false and the user activates a new ungrouped tab
        // we don't collapse the group
        thisWindowData.groupActiveDuringLastCompactId = activeTab.groupId;
        saveWindowData();
    }

    // ==================================================================
    // (E) finally, move all the UNGROUPED tabs to the very right, preserving their order
    // ==================================================================
    console.log(CONSOLE_PREFIX + " ==== (E) Aliging ungrouped tabs rightmost...");

    // we cureently always align ungrouped tabs to ther right, regardless of alignActiveTabGroup...

    // a, b, c are ungrouped tabs
    // A, B, C are groups

    // userOptions.alignActiveTabGroup == Align.RIGHT
    // 0:A, 1:B~~, 2:C, 3:D,   a, b, c
    // 0:A, 1:C,   2:D, 3:B~~, a, b, c   <-- ungrouped tabs are aligned to the right (opposite side of the collapsed groups)

    // userOptions.alignActiveTabGroup == Align.LEFT, if we kept ungrouped tabs to the LEFT
    // a, b, c, 0:A, 1:B~~, 2:C
    // a, b, c, 0:B:~~, 1:A, 2:C    <-- ungrouped tabs are aligned to the left (opposite side of the collapsed groups)
    //                                  but this feels wrong because the active group then ends up in the middle

    // userOptions.alignActiveTabGroup == Align.LEFT, if we kept ungrouped tabs to the RIGHT
    // 0:A, 1:B~~, 2:C, a, b, c
    // 0:B:~~, 1:A, 2:C, a, b, c
    //

    await alignUngroupedTabs(activeTab.windowId);

}

// schedule a timer for a collapse-and-move operation (after delayMs)
// on all other tab groups in the window apart from the group of the given "tab"
//
function scheduleCompactOtherGroups(tab, delayMs)
{
    // as things stand, tab is active but the other groups have not been collapsed
    // nor has this active tab's group been moved around

    if (tab.groupId === chrome.tabGroups.TAB_GROUP_ID_NONE && !userOptions.compactOnActivateUngroupedTab)
    {
        console.debug(`${CONSOLE_PREFIX} Tab ${tab.id}, window ${tab.windowId} is ungrouped and compactOnActivateUngroupedTab is false.  Taking no further action.`);
        return;
    }

    console.debug(`${CONSOLE_PREFIX} Tab ${tab.id}, window ${tab.windowId}, group ${tab.groupId}. Scheduling compact for the window...`);

    // clear any pending operation timers on the current tab's window
    cancelCompactTimer(tab.windowId);

    console.debug(`${CONSOLE_PREFIX} Scheduling compact for window ${tab.windowId} in ${delayMs}ms...`);

    let thisWindowData = getWindowData(tab.windowId);

    // schedule the collapse-and-move operation
    thisWindowData.compactTimer = setTimeout(async () =>
    {
        // delete our own timer as we're now running
        thisWindowData.compactTimer = null;

        try
        {
            // as tab objects are not 'live' and may be stale by the time this runs,
            // we refetch the tab object to ensure we have the latest information

            // what if this tab has been moved to another window in the meantime?
            //    we'll then be compacting the new window but not the old
            //    but the old window will have a new tab activated by the act of moving the tab group anyway
            // what if this tab has been closed?
            //    log the error but continue anyway because the activation of another tab would have cancelled this timer anyway

            let updatedTab
            try
            {
                updatedTab = await chrome.tabs.get(tab.id);
            }
            catch (err)
            {
                // the tab has likely been closed but if it has, the activation of another tab would happen and have cancelled this timer anyway
                console.error(`${CONSOLE_PREFIX} Failed to retrieve tab with ID ${tab.id} after compact timer ended.  Perhaps tab was closed?`, err);
                throw err;
            }

            await compactGroups(updatedTab);

        }
        catch (err)
        {
            console.error(CONSOLE_PREFIX + " Failed to perform compact operation after timer:", err);
        }

    }, delayMs);

}


// test to see if a recently created tab is (likely to be) a 'fallback' tab:
// i.e. a tab that was auto-created by the browser
// because the user collapsed the last expanded tab group in the window and there were no ungrouped tabs
// OR
// if user just created a new window (i.e. this is the only tab in the window)
// returns true if the window consists soley of this ungrouped tab and 0 or more collapsed tab groups
//
async function isFallbackTab(newTab)
{

    if (!newTab)
    {
        console.error(CONSOLE_PREFIX + " No tab provided to isFallbackTab");
        throw new Error("No new tab provided to isFallbackTab");
    }

    if (newTab.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE)
    {
        // we cannot be a fallback tab if we are in a group
        return false;
    }

    let win;
    try
    {
        // { populate: true } ensures that the .tabs property of the win object is filled
        win = await chrome.windows.get(newTab.windowId, { populate: true });
    }
    catch (err)
    {
        console.error(`${CONSOLE_PREFIX} Error retrieving window with ID ${newTab.windowId} for tab:`, err);
        throw new Error("Failed to retrieve window information");
    }

    // create an array of all the OTHER tabs in the window (grouped or ungrouped)
    let otherTabs = win.tabs.filter(tab => tab.id !== newTab.id);

    if (otherTabs.length === 0)
    {
        // so window contains only this tab
        // treat as a fallback tab
        return true;
    }
    else
    {
        // Filter out tabs that are in a group
        let ungroupedOtherTabs = otherTabs.filter(tab => tab.groupId === chrome.tabGroups.TAB_GROUP_ID_NONE);

        if (ungroupedOtherTabs.length > 0)
        {
            // there are some other ungrouped tabs in the window
            // so this wouldn't be a fallback tab
            return false;
        }
        else
        {
            try
            {
                // expanded tab groups are ones that are not collapsed :)
                const expandedTabGroups = await chrome.tabGroups.query({ windowId: win.id, collapsed: false })

                if (expandedTabGroups.length > 0)
                {
                    // there are some expanded tab groups in the window
                    // so this wouldn't be a fallback tab
                    return false;
                }

                // window contains only this tab and collapsed tab groups, so this newly created tab is likely a fallback tab
                return true;
            }
            catch (err)
            {
                console.error(`${CONSOLE_PREFIX} Error retrieving expanded tab groups for window with ID ${win.id} in isFallbackTab:`, err);
                throw new Error(`Failed to retrieve expanded tab groups for window with ID ${win.id} in isFallbackTab`);
            }
        }
    }

}



// return the title of group to autogroup a tab into based on the supplied url
// or null if url matches no autogrouping rules
// TODO: perhaps we should only return a group name if it is a valid group and the group is open?
//
function getAutoGroup(url)
{
    // this is done for efficiency reasons so we don't keep calculating the hostname for every hostname-based rule
    const hostname = (new URL(url)).hostname;

    // we examine the properties of the autoGroupRules object using Object.entries()
    // which returns an array of elements which are arrays with 2 elements [key, value]
    // e.g.
    /*
    [
       ['Guild Wars 2', [ {rule1}, {rule2} ...],
       ['Streaming', [ {rule1}, {rule2} ...] ],
       ['Testing', [ {rule1}, {rule2} ...] ],
    ]
    */

    for (const [autoGroupName, autoGroupRules] of Object.entries(userOptions.autoGroupRules))
    {
        console.debug(`${CONSOLE_PREFIX} Examining auto group rules for group ${autoGroupName}:`, autoGroupRules);

        const isMatch = autoGroupRules.some((autoGroupRule) =>
        {
            console.debug(`${CONSOLE_PREFIX} Checking rule of type ${enumValueToName(autoGroupRule.type, AUTO_GROUP_PATTERN_TYPE)} with pattern:`, autoGroupRule.pattern);
            return doesAutoGroupRuleMatch(autoGroupRule, url, hostname);
        });

        if (isMatch)
        {
            return autoGroupName;
        }
    };

    return null;
}



function doesAutoGroupRuleMatch(autoGroupRule, url, hostname)
{
    switch (autoGroupRule.type)
    {
        case AUTO_GROUP_PATTERN_TYPE.DOMAINNAME:
            if (hostname === autoGroupRule.pattern || hostname.endsWith('.' + autoGroupRule.pattern))
            {
                console.log(`${CONSOLE_PREFIX} URL ${url} MATCHES domainname pattern:`, autoGroupRule.pattern);
                return true;
            }

            break;
        case AUTO_GROUP_PATTERN_TYPE.REGEXP:
            if (autoGroupRule.regexpCompiled === null)
            {
                try
                {
                    console.log(`${CONSOLE_PREFIX} Compiling regexp pattern:`, autoGroupRule.pattern);
                    autoGroupRule.regexpCompiled = new RegExp(autoGroupRule.pattern);
                }
                catch (err)
                {
                    console.error(`${CONSOLE_PREFIX} Invalid regexp pattern in auto-group rule:`, autoGroupRule.pattern, err);
                    autoGroupRule.regexpCompiled = false;
                }
            }

            if (autoGroupRule.regexpCompiled)
            {
                if (autoGroupRule.regexpCompiled.test(url))
                {
                    console.log(`${CONSOLE_PREFIX} URL ${url} MATCHES regexp pattern:`, autoGroupRule.pattern);
                    return true;
                }
            }
            else
            {
                console.debug(`${CONSOLE_PREFIX} URL ${url} does NOT match regexp pattern:`, autoGroupRule.pattern);
            }

            break;
        default:
            console.error(`${CONSOLE_PREFIX} Unknown type in auto-group rule:`, autoGroupRule.type);
    }
    return false;
}


// ==================================================================
// define our listeners
// ==================================================================


// Listen for messages from content scripts
//
function onRuntimeMessage(message, sender, sendResponse)
{

    switch (message.action)
    {
        case 'mouseInContentArea':
            let isMouseInContentArea = message.value;
            let contentTab = sender.tab;

            if (!contentTab)
            {
                console.error(CONSOLE_PREFIX + ' No sender tab for mouseInContentArea event');
                sendResponse({ status: "failed" });
                return;
            }

            if (!contentTab.active)
            {
                console.warn(CONSOLE_PREFIX + ' Mouse ' + (isMouseInContentArea ? 'entered' : 'left') + ' the content area of a non-active tab', contentTab);
            }

            if (isMouseInContentArea)
            {
                console.debug(CONSOLE_PREFIX + ' Mouse entered contentTab', contentTab);
                scheduleCompactOtherGroups(contentTab, userOptions.delayCompactOnEnterContentAreaMs);
            }
            else
            {
                console.debug(`${CONSOLE_PREFIX} Mouse left contentTab : url is ${contentTab.url}, pendingUrl is ${contentTab.pendingUrl}`, contentTab);
                // we cancel all the collapse operations - they didn't stay in the content area long enough to trigger a compact
                cancelCompactTimer(contentTab.windowId);
            }

            // we respond with an 'ok' but the content script doesn't actually do anything with this response atm
            sendResponse({ status: "ok" });
            break;

        default:
            console.error(`${CONSOLE_PREFIX} Unexpected action in this message from content script:`, message);
            sendResponse({ status: "invalidAction" });

    }

}



// helper function to perform when a system (uninjected) tab has been activated
//
function onActivateUninjectableTab(tabId)
{
    console.debug(`${CONSOLE_PREFIX} >>> Activated uninjectable tab ${tabId}...`);

    chrome.tabs.get(tabId)
        .then((activeTab) =>
        {
            let winData = getWindowData(activeTab.windowId);

            if (winData.newTabId === activeTab.id)
            {
                console.log(CONSOLE_PREFIX + " Ignoring first activation of newly created tab", activeTab.id)
                winData.newTabId = null;
                return;
            }

            scheduleCompactOtherGroups(activeTab, userOptions.delayCompactOnActivateUninjectedTabMs);
        },
            (err) =>
            {
                console.error(`${CONSOLE_PREFIX} Failed to get activated tab ${tabId}`, err);
            }
        );
}

// Listen for tab activation to schedule collapse of non-active groups
// used as a fallback to trigger compaction when the content script
//   can't be injected into the active tab's content pane
//
async function onTabActivated(activeInfo)
{
    // activeInfo is an object with
    //  activeInfo.tabId
    //  activeInfo.windowId

    if (!activeInfo.windowId)
    {
        console.error(CONSOLE_PREFIX + ' no windowId in onTabActivated');
        return;
    }

    console.debug(`${CONSOLE_PREFIX} Tab activated.  activeInfo:`, activeInfo);

    let thisWinData = getWindowData(activeInfo.windowId);
    thisWinData.lastActiveTabId = activeInfo.tabId;
    saveWindowData();

    console.debug(CONSOLE_PREFIX + " >>> onActivated tab id:", activeInfo.tabId);

    if (await isContentScriptActive(activeInfo.tabId))
    {
        console.debug(`${CONSOLE_PREFIX} Activated tab ${activeInfo.tabId} has content script injected - waiting for mouse to enter content area to trigger compact...`);

        // we might have triggered a compact from clicking a system tab and then have switched to this tab
        // so we cancel any ticking timers and just await the user moving their mouse cursor into the content area of this tab to trigger a compact
        cancelCompactTimer(activeInfo.windowId);
        return;
    }

    if (!DYNAMIC_INJECTS)
    {
        console.log(`${CONSOLE_PREFIX} >>> Activated tab ${activeInfo.tabId} has NO content script injected - starting timer for compact...`);
        onActivateUninjectableTab(activeInfo.tabId);
        return;
    }

    // remove/comment this line if uncommenting the code for dynamic injected below
    console.error(`${CONSOLE_PREFIX} Activated tab ${activeInfo.tabId} has no content script injected and dynamic injects are enabled but the code is commented out.`);

    // try to dynamically inject content script
    // you can comment out if DYNAMIC_INJECTS is false
    // to stop Google complaining that the manifest.json lacks 'scripting' permission
    /*
    chrome.scripting.executeScript({ target: { tabId: activeInfo.tabId }, files: ["content.js"], injectImmediately: true }, () =>
    {
        if (chrome.runtime.lastError)
        {
            // this tab doesn't support content script (e.g. about:blank, Google Web Store, browser settings)
            switch (chrome.runtime.lastError.message)
            {
                // expected injection fails:
                case "Cannot access a chrome:// URL":
                case "The extensions gallery cannot be scripted.":
                case "Cannot access a chrome-extension:// URL of different extension":
                case "Extension manifest must request permission to access this host":
                    // the last one tends to happen when a chrome:// URL tab is not yet loaded when activated

                    console.log(`${CONSOLE_PREFIX} Expected error injecting into tab ${activeInfo.tabId}:`, chrome.runtime.lastError.message);
                    break;
                // unexpected injection fails:
                default:
                    const errMsg = chrome.runtime.lastError.message;

                    const tab = chrome.tabs.get(activeInfo.tabId).then((tab) =>
                    {
                        console.error(`${CONSOLE_PREFIX} Unexpected error injecting into tab ${tab.id}: ${errMsg}`, tab);
                    });

            }

            onActivateUninjectableTab(activeInfo.tabId);
        }
        else
        {
            console.log(CONSOLE_PREFIX + " Content script injected into activated tab", activeInfo.tabId);
        }
    });
    */


}


// Listen for when a tab is updated, in particular when moved into a new group
// fallback for if the content script cannot be injected into the tab contents
//
function onTabUpdated(tabId, changeInfo, tab)
{
    console.debug(`${CONSOLE_PREFIX} Tab ${tabId} updated.  changeInfo:`, changeInfo, tab);

    if (userOptions.autoGroupingEnabled &&
        (userOptions.autoGroupingChecksExistingTabs || tabsAwaitingFirstUrl.has(tabId)) &&
        changeInfo.url && !changeInfo.url.startsWith('chrome://'))
    {
        // url has changed, is not falsy, and isn't a system URL
        // status may well be "loading" but thats ok - we can still auto group loading tabs

        console.log(`${CONSOLE_PREFIX} New URL ${changeInfo.url} in tab: `, tab);

        // check if this tab should be auto grouped (depending on URL)
        const autoGroupName = getAutoGroup(changeInfo.url);

        if (autoGroupName)  // if autoGroupName is truthy
        {
            chrome.tabGroups.query({ title: autoGroupName })
                .then((groups) =>
                {
                    if (groups.length === 0)
                    {
                        console.warn(`${CONSOLE_PREFIX} Couldn't find tab group with title "${autoGroupName}" when attempting to auto-group`);
                        // we cannot interact with or query closed tab groups with the current API so there's not much we can do at this point
                        // besides creating the group but a closed group with this name might already exist
                        return;
                    }

                    if (groups.length > 1)
                    {
                        console.warn(`${CONSOLE_PREFIX} Found multiple (${groups.length}) tab groups with title "${autoGroupName}" when attempting to auto-group`);
                    }

                    // just take the first matching tab group
                    let group = groups[0];

                    // if it's not already in this group
                    if (tab.groupId !== group.id)
                    {
                        // NB: this is all done asynchronously to this function
                        chrome.tabs.group({ groupId: group.id, tabIds: tabId })
                            .then(() =>
                            {
                                console.log(`${CONSOLE_PREFIX} Autogrouped tab into group: `, tab, group);

                                // focus the window
                                chrome.windows.update(group.windowId, { focused: true })
                                    .then(() =>
                                    {
                                        // activate the tab
                                        chrome.tabs.update(tabId, { active: true })
                                            .then(() =>
                                            {
                                                console.debug(`${CONSOLE_PREFIX} Activated tab ${tabId} after auto-grouping`);
                                            })
                                            .catch((err) =>
                                            {
                                                console.warn(`${CONSOLE_PREFIX} Error activating the autogrouped tab ${tabId}`, err);
                                            });
                                    })
                                    .catch((err) =>
                                    {
                                        console.warn(`${CONSOLE_PREFIX} Error focusing the window containing the autogroup`, err);
                                    });

                            })
                            .catch((err) =>
                            {
                                console.error(CONSOLE_PREFIX + " Error auto-grouping new tab", err);
                            });
                    }

                })
                .catch((err) =>
                {
                    console.error(`${CONSOLE_PREFIX} Error retrieving tab group with title '${autoGroupName}':`, err);
                });
        }

        // delete from our Set
        tabsAwaitingFirstUrl.delete(tabId);
    }


    // tab's group assignment was changed
    if (changeInfo.hasOwnProperty('groupId'))
    {
        isContentScriptActive(tabId).then((isInjected) =>
        {
            if (isInjected)
            {
                console.log(`${CONSOLE_PREFIX} >>> Injected tab ${tabId} moved to group ${changeInfo.groupId} - ignoring`)
                // we don't need to take any action on update of a tab with the content script injected
                // because the content script will collapse the tab groups on mouse entering the content area
                return;
            }

            // non-injected tab..
            if (changeInfo.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE)
            {
                // the tab wasn't ungrouped
                console.log(`${CONSOLE_PREFIX} >>> Uninjected tab ${tabId} moved to group ${changeInfo.groupId}`);

                // fetch tab object
                /*
                chrome.tabs.get(tabId, (tab) =>
                {
                    if (chrome.runtime.lastError)
                    {
                        console.error(`${CONSOLE_PREFIX} Failed to get updated tab ${tabId}`, chrome.runtime.lastError);
                        return;
                    }

                    // if a tab is moved into a collapsed group
                    //   if the moved tab is the active tab, the browser will automatically expand the group
                    //   if the moved tab isn't the active tab, the new group will stay collapsed
                    if (tab.active)
                    {
                        scheduleCompactOtherGroups(tab, userOptions.delayCompactOnActivateUninjectedTabMs);
                    }
                    else
                    {
                        console.log(CONSOLE_PREFIX + " Regrouped tab is not the active tab.  Ignoring.");
                    }
                });
                */

                if (tab.active)
                {
                    scheduleCompactOtherGroups(tab, userOptions.delayCompactOnActivateUninjectedTabMs);
                }
                else
                {
                    console.log(CONSOLE_PREFIX + " Regrouped tab is not the active tab.  Ignoring.");
                }


            }
        });

    };


}


// Listen for new tab creation to add it to the active group if applicable
// (if the user wants to create a new ungrouped tab on a window with only tab groups,
// they can create the tab and then just drag it outside the tab groups)
//
function onTabCreated(newTab)
{
    console.debug(`${CONSOLE_PREFIX} New tab created`, newTab);

    // we immediately grab this before onActivated runs for this tab and updates it with this new tab's ID
    let lastActiveTabId = getWindowData(newTab.windowId).lastActiveTabId;

    // used for auto-grouping
    tabsAwaitingFirstUrl.add(newTab.id);

    if (!userOptions.moveNewTabsToGroupOfLastActiveTabInWindow)
    {
        return;
    }

    console.log(`${CONSOLE_PREFIX} >>> New tab ${newTab.id} created in window ${newTab.windowId}`, newTab);

    isContentScriptActive(newTab.id)
        .then((isInjected) =>
        {
            if (!isInjected)
            {
                // store that this is a new tab so onActivated doesn't kick in too
                // note, the code below this will run asynchronously but that's ok as
                // it's onActivated that uses newlyCreatedTabs

                getWindowData(newTab.windowId).newTabId = newTab.id;
            }
        });

    if (newTab.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE)
    {
        console.log(CONSOLE_PREFIX + " Newly created tab is already in a group - ignoring");
        return;
    }

    // pause to give the browser time to potentially move the tab into a new group if applicable
    setTimeout(async () =>
    {
        // refetch the newTab object to check for updates
        // we overwrite the old newTab object but that's fine because we are done with it
        try
        {
            newTab = await chrome.tabs.get(newTab.id);
        }
        catch (err)
        {
            console.error(`${CONSOLE_PREFIX} Failed to refresh newly created tab data ${newTab.id} after delay`, err);
            return;
        }

        // If tab has NOW been assigned a group, skip grouping
        if (newTab.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE)
        {
            console.log(`${CONSOLE_PREFIX} Tab ${newTab.id} has been placed into group ${newTab.groupId} since its creation (probably by browser)`);
            return;
        }

        // when the user collapses all tab groups in a window in which there are no other tabs,
        // the browser will auto create a new ungrouped 'fallback' tab which should be left ungrouped
        // as otherwise we'll try to put the browser autocreated fallback tab into the last active group
        if (await isFallbackTab(newTab))
        {
            console.log(CONSOLE_PREFIX + " New tab is fallback tab - ignoring")
            return;
        }

        // if the windowData had record of the ID of the last active tab
        if (lastActiveTabId)
        {
            if (lastActiveTabId === newTab.id)
            {
                console.warn(CONSOLE_PREFIX + " New tab is also the last active tab in the window. Weird.");
                return;
            }

            // retrieve the last active tab in this window (before this new tab)

            let prevActiveTab;
            try
            {
                prevActiveTab = await chrome.tabs.get(lastActiveTabId);
            }
            catch (err)
            {
                console.error(`${CONSOLE_PREFIX} Error retrieving tab ${lastActiveTabId}: `, err);
                return;
            }

            if (prevActiveTab && prevActiveTab.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE)
            {
                console.log(`${CONSOLE_PREFIX} Adding new tab (${newTab.id}) to group of last tab (${prevActiveTab.groupId})`);

                // Add the new tab to the group of the last focused tab
                // NOTE: this will trigger the onUpdated event and therefore run collapseOtherGroups()
                try
                {
                    await chrome.tabs.group({ groupId: prevActiveTab.groupId, tabIds: newTab.id })
                }
                catch (err)
                {
                    console.error(CONSOLE_PREFIX + " Error grouping new tab", err);
                };
            }
            else
            {
                console.log(CONSOLE_PREFIX + " No group found for last active tab " + prevActiveTab.id);
            }

        }
        else
        {
            // maybe a brand new window.  just let the new tab be where it is
            console.log(CONSOLE_PREFIX + " No last active tab found for window " + newTab.windowId);
        }

    }, CHECK_GROUPING_DELAY_ON_CREATE_TAB_MS);

}



// as the user drags around a tab group, while holding mouse button, this event
// can trigger multiple times as the tab display updates
//
function onTabGroupMoved(group)
{
    console.debug(`${CONSOLE_PREFIX} Tab group moved:`, group);

    // when we try to move a collapsed tab group, it is expanded and the first tab is activated
    // this means onTabActivated() is called as soon as we start moving it
    // this is a problem if the first tab doesnt have a content script because we will likely be attempting to run compactGroups()
    // when the tabs cannot be edited and receive the error "Error: Tabs cannot be edited right now (user may be dragging a tab)"

    // what happens if we moved it leftmost/rightmost (where active groups are moved)?
    // well, the user seems to want it as the active group

    // what happens if this group was the previously active group
}



function onTabGroupRemoved(group)
{
    console.debug(`${CONSOLE_PREFIX} Tab group removed:`, group);
    // TODO: update windowData if necessary
}



// listen for when the options page was used to save new options in the storage
// we need to update the userOptions object to match
//
function onStorageChanged(changes, areaName)
{

    if (areaName === 'sync')
    {
        console.log(CONSOLE_PREFIX + ' >>> storage.OnChanged', changes, areaName);

        // example structure of `changes`:
        // changes = {
        //      addedOptionName:   { newValue: 666 }
        //      changedOptionName: { oldValue: 1, newValue: 2 },
        //      deletedOptionName: { oldValue: 69 },
        // }

        const changedPropertyNames = Object.keys(changes);

        for (const changedPropertyName of changedPropertyNames)
        {
            if (changes[changedPropertyName].newValue !== undefined)
            {
                // item changed or added to the storage
                console.debug(`${CONSOLE_PREFIX} storage updating ${changedPropertyName} to`, changes[changedPropertyName].newValue);
                userOptions[changedPropertyName] = changes[changedPropertyName].newValue;
            }
            else
            {
                // an item was removed from the storage
                console.debug(`${CONSOLE_PREFIX} storage removing: ${changedPropertyName}`);
                delete userOptions[changedPropertyName];
            }
        }

        console.log(CONSOLE_PREFIX + " userOptions updated:", userOptions);
    }
}



// called when a window is created
//
function onWindowCreated(newWindow)
{
    console.log(CONSOLE_PREFIX + ' >>> New window was created:', newWindow);
    getWindowData(newWindow.id, true);  // initialise window data, clobber any existing data ()
}



// called when a window is removed
//
function onWindowRemoved(windowId)
{
    if (globalWindowDataMap.delete(windowId))
    {
        console.log(CONSOLE_PREFIX + ' >>> Closed window deleted from globalWindowDataMap, had ID:', windowId);
        saveWindowData();
    }
    else
    {
        console.warn(CONSOLE_PREFIX + ' >>> Closed window not found in globalWindowDataMap, had ID:', windowId);
    }
}



// called when the service worker is about to be unloaded (e.g. due to inactivty or low system resources)
//
function onSuspend()
{
    deregisterListeners();
    //saveWindowData();  // chrome.storage.local.set() is async so may not complete
    console.log(CONSOLE_PREFIX + 'Service worker is being suspended/stopped.  Sayonara!  o/');
}


function onSuspendCanceled()
{
    console.log(CONSOLE_PREFIX + 'Service worker suspend was canceled.  Staying alive and re-registering listeners!');
    registerListeners();
}


// register our listeners
//
function registerListeners()
{
    chrome.runtime.onMessage.addListener(onRuntimeMessage);

    chrome.tabs.onActivated.addListener(onTabActivated);
    chrome.tabs.onUpdated.addListener(onTabUpdated);
    chrome.tabs.onCreated.addListener(onTabCreated);

    chrome.tabGroups.onRemoved.addListener(onTabGroupRemoved);
    chrome.tabGroups.onMoved.addListener(onTabGroupMoved);

    chrome.windows.onCreated.addListener(onWindowCreated);
    chrome.windows.onRemoved.addListener(onWindowRemoved);

    chrome.storage.onChanged.addListener(onStorageChanged);

    chrome.runtime.onSuspend.addListener(onSuspend);
    chrome.runtime.onSuspendCanceled.addListener(onSuspendCanceled);

    console.log(CONSOLE_PREFIX + " Listeners registered");

}



// remove all the listeners
//
function deregisterListeners()
{
    chrome.runtime.onMessage.removeListener(onRuntimeMessage);

    chrome.tabs.onActivated.removeListener(onTabActivated);
    chrome.tabs.onUpdated.removeListener(onTabUpdated);
    chrome.tabs.onCreated.removeListener(onTabCreated);

    chrome.tabGroups.onRemoved.removeListener(onTabGroupRemoved);
    chrome.tabGroups.onMoved.removeListener(onTabGroupRemoved);

    chrome.windows.onCreated.removeListener(onWindowCreated);
    chrome.windows.onRemoved.removeListener(onWindowRemoved);

    chrome.storage.onChanged.removeListener(onStorageChanged);

    chrome.runtime.onSuspend.removeListener(onSuspend);

    console.log(CONSOLE_PREFIX + " Listeners deregistered");
}



// load windowData from local storage into the global variable globalWindowDataMap
// prune any entries for windows that have been closed since the last save
// and initialise entries for any new windows
//
async function loadWindowDataFromStorage()
{
    try
    {
        // windowData is stored in storage rather than just as a global variable because
        // the extension service worker can be terminated and restarted by the browser at any time,
        // and we want this data to persist
        const got = await chrome.storage.local.get(['windowData']);
        if (got.windowData)
        {
            console.log(CONSOLE_PREFIX + " Retrieved windowData from local storage", got.windowData);

            // look at all the current windows
            const allWindows = await chrome.windows.getAll({ populate: false, windowTypes: ['normal'] });
            const allWindowIds = allWindows.map(win => win.id);

            // if a new window was created while we weren't running and
            // just happens to have the same ID as a different window that was closed while we weren't running
            // i don't think there's a lot we can do

            // verify that these window IDs are still valid - filter out all entries for windows that no longer exist
            globalWindowDataMap = new Map(got.windowData.filter(([winId, winData]) =>
            {
                if (allWindowIds.includes(winId))
                {
                    return true;
                }
                console.warn(CONSOLE_PREFIX + " Window vanished since last windowData save: ", winId);
                return false;
            }));

            // Initialize windowData objects for any window with IDs not already present
            await Promise.all(allWindows.map(win => getWindowData(win.id)));

            saveWindowData();  // save the pruned and initialised windowData back to local storage
            console.log(CONSOLE_PREFIX + " Finished pruning and initialising globalWindowDataMap:", globalWindowDataMap);

        }
        else
        {
            console.warn(CONSOLE_PREFIX + " Empty or no windowData found in local storage. Ignoring");
        }
    }
    catch (err)
    {
        console.error(CONSOLE_PREFIX + " Failed to retrieve windowData from local storage:", err);
    }
}



function loadOptionsFromStorage(clearUnrecognisedKeys = false)
{
    // populate userOptions from the sync extension storage
    // the argument to .get() here is a dictionary specifying default values
    chrome.storage.sync.get(DEFAULT_OPTIONS).
        then((options) =>
        {
            userOptions = options;
            console.log(CONSOLE_PREFIX + " Options read from storage:", userOptions);
        },
            (err) =>
            {
                console.error(CONSOLE_PREFIX + " Failed to read options from storage, using defaults:", err);
            }
        );


    // local any stored and unrecognised keys, in case there are any old options from a previous version of the extension
    chrome.storage.sync.getKeys()
        .then((keys) =>
        {
            // Filter out any unrecognised keys
            const recognisedKeys = Object.keys(DEFAULT_OPTIONS);
            const unrecognisedKeys = keys.filter(key => !recognisedKeys.includes(key));

            if (unrecognisedKeys.length > 0)
            {
                console.warn(CONSOLE_PREFIX + " Found unrecognised keys in storage:", unrecognisedKeys);

                if (clearUnrecognisedKeys)
                {
                    chrome.storage.sync.remove(unrecognisedKeys)
                        .then(() =>
                        {
                            console.log(CONSOLE_PREFIX + " Unrecognised keys removed from storage:", unrecognisedKeys);
                        },
                            (err) =>
                            {
                                console.error(CONSOLE_PREFIX + " Failed to remove unrecognised keys from storage:", err);
                            });
                }
            }
        });

}



// let's guess if the browser is starting up
//
async function isBrowserLikelyStartingUp()
{
    try
    {
        // If multiple windows are being restored, we're likely in a startup scenario
        return (await chrome.windows.getAll().length === 0)
    }
    catch (err)
    {
        // failed to call chrome.windows.getAll() suggests we're starting up and the API isn't ready yet?
        return true;
    }
}



// event handler for when we think the browser is starting up -
// we delay our extension startup logic for a short while to avoid interfering with the browser's own startup procedure
// of restoring windows, tabs, and groups from a previous session
//
function onBrowserStartingUp()
{
    // if we haven't already handled a browser startup scenario
    if (!browserStartingUp)
    {
        browserStartingUp = true;  // this will stop our initial setTimeout() (below) from progressing any further
        console.log(`${CONSOLE_PREFIX} >>> Browser is starting up - waiting ${LISTEN_DELAY_ON_BROWSER_STARTUP_MS} ms before extension startup`);
        // FIXME: we should wait until all windows have loaded, not just a fixed time - letting it "settle"

        setTimeout(startUp, LISTEN_DELAY_ON_BROWSER_STARTUP_MS);
    }
}


// activate the extension
//
async function startUp()
{
    console.log(CONSOLE_PREFIX + " >>>>>>>> Starting up...");
    registerListeners();
    browserStartingUp = false; // it was either not starting up, or we started extension because we decided brower startup had finished

    await loadWindowDataFromStorage();

    // we're done listening for this
    chrome.runtime.onStartup.removeListener(onBrowserStartingUp());
}



// ====================================================
// ====================================================
//           MAIN SCRIPT LOGIC STARTS HERE
// ====================================================
// ====================================================


// Stop console.debug() working if we're not debugging
if (!SHOW_DEBUG_CONSOLE_MSGS)
{
    console.debug = () => { };
}

let browserStartingUp = false;

// We try to delay starting extension logic for a short while to avoid messing while
// the browser restores windows, tabs, and groups from a previous session
// NOTE: there's no guarantee that the listener will be registered before the startUp event has fired
if (isBrowserLikelyStartingUp())
{
    console.log(CONSOLE_PREFIX + " >>> Browser is *likely* starting up - delaying extension startup logic...");
    onBrowserStartingUp();
}
else
{
    chrome.runtime.onStartup.addListener(onBrowserStartingUp());

    setTimeout(() =>
    {
        if (!browserStartingUp)
        {
            console.log(CONSOLE_PREFIX + " >>> Timed out waiting for onStartup event.  Assuming browser isn't starting up.");
            startUp();
        }
    }, ON_STARTUP_WAIT_TIMEOUT_MS);

}

loadOptionsFromStorage(true);

console.log(`${CONSOLE_PREFIX} Tab Groups Plus v${chrome.runtime.getManifest().version} service worker has started.`);

/*
console.debug("this is console.debug", console); // shows with chromium "Verbose"
console.log("this is console.log", console);     // shows with chromium "Info"
console.info("this is console.info", console);   // shows with chromium "Info"
console.warn("this is console.warn", console);   // shows with chromium "Warnings"
console.error("this is console.error", console); // shows with chromium "Errors"
*/