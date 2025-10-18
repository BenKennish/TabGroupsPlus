// ===========================================================================
// Tab Groups Plus (TGP)
// service worker (background.js)
// ===========================================================================

// TODO: FEATURE: option to auto close tab groups that haven't been used in a while (not just collapse the group, actually *close* them)
// doesn't seem possible as chrome API doesn't (yet) allow for closing a tab group other than just closing all its tabs one-by-one

// TODO: FEATURE: option to auto-group new tabs according to tab.url (we will need the 'tabs' permission).
//       we'll need to store the name of the Tab Group as the ID can change between sessions

// TODO: FEATURE: button that will store information about all groups, then tear them all down, and recreate them so that they are in the right order?  how does this affect other devices?

// TODO: SECURITY: make content scripts optional
// we can use chrome.scripting.registerContentScripts() if we have the scripting permission
//  so perhaps we optionally request 'scripting' and put "<all_urls>"" in optional_host_permissions then

// TODO: OPTIMIZATION: for any process, fetch the tab object and pass it around rather than just the tab ID (but only when necessary)
//       will the tab object get stale?  i.e. if the tab is moved or closed?


import { ALIGN, DEFAULT_OPTIONS, CONSOLE_PREFIX } from './shared.js';

// timeout (ms) for receiving the browser's onStartup event
// if we receive this in time, we know to wait longer for initialisation of windows, tabs, and groups
const ON_STARTUP_WAIT_TIMEOUT_MS = 500;

// time to wait (ms) before listening for events if the browser is starting up
// (we allow time for it to create windows, tabs, etc when restoring previous session)
const LISTEN_DELAY_ON_BROWSER_STARTUP_MS = 5000;

// time to wait after a new tab is created before checking its group
// (the reason for this is that the browser may move the tab into a group
// automatically very shortly after its creation)
const CHECK_GROUPING_DELAY_ON_CREATE_TAB_MS = 250;

// enable/disable console.debug() messages
const SHOW_DEBUG_CONSOLE_MSGS = true;

// setting to true requires setting "host_permissions" in manifest.json and adding the "scripting" permission
// and then uncommenting code below
const DYNAMIC_INJECTS = false;

// used to store user options from the storage in this object
let userOptions = {};

// map window ID to object about that window (see newWindowDataObj below)
// don't touch this directly - use getWindowData() to access it
// and call saveWindowData() to save it back to local storage
let globalWindowDataMap = new Map();


// example of data structure within the windowData map defined above
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

    // set to the ID of a new tab so that onActivate and onCreate don't stomp on each other
    newTabId: null,

    // setTimeout timer object for the compact operation gets stored here
    // so that it can be cancelled if necessary
    compactTimer: null
};



// ============================================================================
// ============================================================================
// ============================================================================


// retrieve data for a window, creating a new entry in the Map if necessary
//
function getWindowData(windowId)
{
    try
    {
        if (!globalWindowDataMap.has(windowId))
        {
            // initialise a new windowData object for this window

            const thisWindowData = { ...newWindowDataObj };
            globalWindowDataMap.set(windowId, thisWindowData);

            if (userOptions.alignActiveTabGroup !== ALIGN.DISABLED)
            {
                // set

                getTabGroupsOrdered(windowId, chrome.tabGroups.TAB_GROUP_ID_NONE).then((groupsOrdered) =>
                {
                    // on new window, assume the tab groups are in the correct order at the start
                    // pretend the leftmost tabgroup was the last active one and was previously in position 0

                    if (userOptions.alignActiveTabGroup === ALIGN.LEFT)
                    {
                        thisWindowData.groupActiveDuringLastCompactId = groupsOrdered.length > 0 ? groupsOrdered[0].id : chrome.tabGroups.TAB_GROUP_ID_NONE;
                        thisWindowData.lastMovedGroupPrevPos = 0;
                        console.log(`${CONSOLE_PREFIX} Initialized windowData entry for window ${windowId}`);
                    }

                    if (userOptions.alignActiveTabGroup === ALIGN.RIGHT)
                    {
                        console.warn(`${CONSOLE_PREFIX} alignActiveTabGroup is ALIGN.RIGHT but sensible initialization of windowData is not implemented yet`);
                    }

                }).catch((err) =>
                {
                    console.error('Error retrieving ordered tab groups in getWindowData()', err);
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
//
function saveWindowData()
{
    // globalWindowDataMap is a Map of objects
    // we store it as an array of objects with methods stripped

    // Convert each element back to a plain object
    const winDataProperties = Array.from(globalWindowDataMap.entries()).map(([winId, winData]) =>
    {
        // TODO: we could strip out the compactTimer property here
        return [winId, { ...winData }]; // spread (...) copies only own properties, no methods
    });


    chrome.storage.local.set({ windowData: winDataProperties })
        .then(() =>
        {
            console.debug(CONSOLE_PREFIX + ' windowData saved to local storage:', winDataProperties);
            console.log(CONSOLE_PREFIX + " >>> windowData saved to local storage");
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
    //return false;

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
            console.warn(`${CONSOLE_PREFIX} Group titled '${group.title}' has NO TABS!?`, group);
            return null;
        }

        // Find the tab with the minimum index
        const firstTab = tabs.reduce((minTab, currentTab) =>
        {
            return (currentTab.index < minTab.index) ? currentTab : minTab;
        });

        return firstTab.index;
    }
    catch (error)
    {
        console.error(`${CONSOLE_PREFIX} Error getting index of first tab in group:`, error);
        return null;
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
        return null;
    }
}


// collapse all tab groups in a window except the one with group ID `excludeGroupId`
// if you want to collapse all groups, pass chrome.tabGroups.TAB_GROUP_ID_NONE for excludeGroupId
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
        throw err; //new Error(`Failed to query tabs of window ${activeTab.windowId}: ${err.message}`);
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


// async helper function for scheduleCompactOtherGroups()
// `activeTab` represents the current active tab of the window (or at least it should be active!)
//
async function compactGroups(activeTab)
{
    console.log(CONSOLE_PREFIX + " >>>>>>>>>>> compactGroups() running for window " + activeTab.windowId + ", active tab is:", activeTab);

    // sanity checks
    if (activeTab.active === false)
    {
        console.error(CONSOLE_PREFIX + " compactGroups() called with a non-active tab!", activeTab);
        return;
    }

    if (userOptions.alignActiveTabGroup !== ALIGN.LEFT &&
        userOptions.alignActiveTabGroup !== ALIGN.RIGHT &&
        userOptions.alignActiveTabGroup !== ALIGN.DISABLED)
    {
        console.error(CONSOLE_PREFIX + ' Unexpected value for alignActiveTabGroup', userOptions.alignActiveTabGroup);
        return;
    }

    const thisWindowData = getWindowData(activeTab.windowId);


    // ==================================================================
    // (1) collapse all the inactive groups
    // ==================================================================
    console.log(CONSOLE_PREFIX + " ==== (1) Collapsing inactive groups...");

    // fetch the IDs of all OTHER groups in this window (excluding the active tab's group) in left-to-right order
    // its possible that activeTab.groupId is TAB_GROUP_ID_NONE (-1) if the active tab is ungrouped
    // which will mean that ALL groups are considered inactive

    let groupNotToCollapseId = activeTab.groupId;

    if (activeTab.groupId === chrome.tabGroups.TAB_GROUP_ID_NONE &&
        userOptions.collapsePreviousActiveGroupOnActivateUngroupedTab === false)
    {
        groupNotToCollapseId = thisWindowData.groupActiveDuringLastCompactId;
    }

    await collapseTabGroupsInWindow(activeTab.windowId, groupNotToCollapseId).catch((err) =>
    {
        console.error(CONSOLE_PREFIX + " Failed to collapse inactive groups", err);
        // we continue...
    });

    // we've now collapsed (or tried to collapse) all the groups except the active one

    // if we are not configured to align the active tab group after collapsing, we're done
    if (userOptions.alignActiveTabGroup === ALIGN.DISABLED)
    {
        thisWindowData.groupActiveDuringLastCompactId = activeTab.group;
        console.log(CONSOLE_PREFIX + " Aligning of active tab group is disabled.  All done");
        return;
    }


    if (activeTab.groupId === thisWindowData.groupActiveDuringLastCompactId)
    {
        console.log(CONSOLE_PREFIX + " Active tab's group was the one moved in the last compact.  All done");
        return;
    }


    if (activeTab.groupId === chrome.tabGroups.TAB_GROUP_ID_NONE &&
        userOptions.collapsePreviousActiveGroupOnActivateUngroupedTab === false
    )
    {
        console.log(`${CONSOLE_PREFIX} Active tab is ungrouped and we kept the last active group open. All done`);
        return;
    }


    // ==================================================================
    // (2) restore the position of the *previously* active group (if there is one)
    // ==================================================================
    console.log(CONSOLE_PREFIX + " ==== (2) Restoring position of group previously moved during compact...");

    console.log(CONSOLE_PREFIX + " groupActiveDuringLastCompactId:", thisWindowData.groupActiveDuringLastCompactId);
    console.log(CONSOLE_PREFIX + " groupActiveDuringLastCompactPrevPos:", thisWindowData.groupActiveDuringLastCompactPrevPos);

    let tabIndexToMoveTo = null;

    if (thisWindowData.groupActiveDuringLastCompactPrevPos !== null &&
        thisWindowData.groupActiveDuringLastCompactId !== chrome.tabGroups.TAB_GROUP_ID_NONE)
    {

        let groupLastMovedDuringCompact;
        try
        {
            groupLastMovedDuringCompact = await chrome.tabGroups.get(thisWindowData.groupActiveDuringLastCompactId);
        }
        catch (err)
        {
            console.warn(`${CONSOLE_PREFIX} Failed to retrieve previously active group with ID ${thisWindowData.groupActiveDuringLastCompactId}.  Perhaps it was closed?`, err);
            groupLastMovedDuringCompact = null;
        }

        if (groupLastMovedDuringCompact === null)
        {
            console.warn(CONSOLE_PREFIX + " No previously active group to restore");
        }
        else
        {
            console.log(`${CONSOLE_PREFIX} Group previously active and previously at group pos index ${thisWindowData.groupActiveDuringLastCompactPrevPos}:`, groupLastMovedDuringCompact);

            // retrieve ALL tab groups in this window in left-to-right order
            const groupsOrdered = await getTabGroupsOrdered(activeTab.windowId, chrome.tabGroups.TAB_GROUP_ID_NONE)
                .catch((err) =>
                {
                    console.error(`${CONSOLE_PREFIX} Failed to retrieve ordered tab groups in window ${activeTab.windowId}`, err);
                    return;
                });

            console.log(`${CONSOLE_PREFIX} All tab groups in window ${activeTab.windowId} in left-to-right order:`, groupsOrdered);

            // hard to explain why this works but it does - magic!
            // i guess we want the group to be to the right of any group in this old position
            thisWindowData.groupActiveDuringLastCompactPrevPos++;

            // retrive the tab group that's currently occupying the group pos index where the previously active group was
            if (groupsOrdered[thisWindowData.groupActiveDuringLastCompactPrevPos])
            {
                // there's a group located in the group index pos where we want to return this group
                // this group will be bumped one place to the right after the move

                console.log(`${CONSOLE_PREFIX} Group currently at group pos ${thisWindowData.groupActiveDuringLastCompactPrevPos}:`, groupsOrdered[thisWindowData.groupActiveDuringLastCompactPrevPos]);

                // fetch the tab index of the first tab of the group that's currently at this group index position
                tabIndexToMoveTo = await getIndexOfFirstTabInGroup(groupsOrdered[thisWindowData.groupActiveDuringLastCompactPrevPos]);

                console.log(`${CONSOLE_PREFIX} ... leftmost tab has index`, tabIndexToMoveTo);

            }
            else
            {
                // this might happen if the user has closed some groups or moved them into a different window
                console.log(CONSOLE_PREFIX + " No group currently at this location.  Moving to rightmost position.");

                // just move this group to the rightmost position
                tabIndexToMoveTo = ALIGN.RIGHT;
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
                let currentTabIndex = await getIndexOfFirstTabInGroup(groupLastMovedDuringCompact);

                // if we are moving the group to the right of its current position
                if (tabIndexToMoveTo > currentTabIndex)
                {
                    // subtract the number of tabs in this group from the index
                    let numTabsInGroup = await countTabsInGroup(groupLastMovedDuringCompact.id);
                    tabIndexToMoveTo -= numTabsInGroup;
                    console.debug(`${CONSOLE_PREFIX} Adjusted target tab index to ${tabIndexToMoveTo} - subtracted ${numTabsInGroup} (tabs in the group to move)`);
                }

                console.log(`${CONSOLE_PREFIX} Moving previously active group ${groupLastMovedDuringCompact.title} to tab index ${tabIndexToMoveTo}...`);

                try
                {
                    await chrome.tabGroups.move(groupLastMovedDuringCompact.id, { index: tabIndexToMoveTo });
                }
                catch (err)
                {
                    console.error(`${CONSOLE_PREFIX} Failed restoring previously active group ${groupLastMovedDuringCompact.title} to tab index ${tabIndexToMoveTo}:`, err);
                    // we continue...
                }

            }

        }
    }

    // we've now returned (or failed to return) the previously active group
    // into the correct place so we clear the record

    thisWindowData.groupActiveDuringLastCompactId = chrome.tabGroups.TAB_GROUP_ID_NONE;
    thisWindowData.groupActiveDuringLastCompactPrevPos = null;

    if (activeTab.groupId === chrome.tabGroups.TAB_GROUP_ID_NONE)
    {
        console.log(`${CONSOLE_PREFIX} Active tab is ungrouped.  All done`);
        saveWindowData();
        return;
    }


    // ==================================================================
    // (3) update the windowData object with new active group's info (before it's moved)
    // ==================================================================
    // NOTE: this only runs after the compact timer has timed out
    // if the user is clicking around quickly, this info is not updating
    // but that's ok because it means we haven't yet moved any groups around either

    console.log(CONSOLE_PREFIX + " ==== (3) Updating windowData object...");

    // refetch ordered list of all tab groups (after the move)
    try
    {
        const groupsOrdered = await getTabGroupsOrdered(activeTab.windowId, chrome.tabGroups.TAB_GROUP_ID_NONE);

        // calculate and store group pos index of the active group (before it is moved to leftmost/rightmost)
        thisWindowData.groupActiveDuringLastCompactPrevPos = groupsOrdered.findIndex((group) =>
        {
            return group && group.id === activeTab.groupId;
        });

        thisWindowData.groupActiveDuringLastCompactId = activeTab.groupId;
    }
    catch (err)
    {
        console.error(`${CONSOLE_PREFIX} Failed to retrieve ordered tab groups in window ${activeTab.windowId}.  Resetting windowData`, err);
        thisWindowData.groupActiveDuringLastCompactId = chrome.tabGroups.TAB_GROUP_ID_NONE;
        thisWindowData.groupActiveDuringLastCompactPrevPos = null;
    }

    console.log(`${CONSOLE_PREFIX} Updated windowData after step (3):`, thisWindowData);
    saveWindowData();

    // ==================================================================
    // (4) position the new active `group` to the very left or very right
    // ==================================================================
    console.log(CONSOLE_PREFIX + " ==== (4) Aliging active group to leftmost/rightmost...");

    try
    {
        await chrome.tabGroups.move(activeTab.groupId, { index: userOptions.alignActiveTabGroup });
    }
    catch (err)
    {
        console.error(`${CONSOLE_PREFIX} Failed to align active group ${activeTab.groupId}:`, err);
        throw err;
    }


    console.log(CONSOLE_PREFIX + " ==== (5) Aliging ungrouped tabs rightmost...");

    // ==================================================================
    // (5) finally, move all the UNGROUPED tabs to the very right, preserving their order
    // ==================================================================

    // a, b, c are ungrouped tabs
    // A, B, C are groups

    // Align.LEFT
    // a, b, c, 0:A, 1:B~~, 2:C
    // a, b, c, 0:B:~~, 1:A, 2:C    <-- ungrouped tabs are aligned to the left (opposite side of the collapsed groups) - may want to make this configurable

    // Align.RIGHT
    // 0:A, 1:B~~, 2:C, 3:D,   a, b, c
    // 0:A, 1:C,   2:D, 3:B~~, a, b, c   <-- ungrouped tabs are aligned to the right (opposite side of the collapsed groups)


    // (4) move all the ungrouped tabs to the leftmost or rightmost position
    // grab all the ungrouped tabs in the window (hopefully will be sorted by left->right position)

    let ungroupedTabs;

    try
    {
        ungroupedTabs = await chrome.tabs.query({ windowId: activeTab.windowId, groupId: chrome.tabGroups.TAB_GROUP_ID_NONE });
    }
    catch (err)
    {
        console.error(CONSOLE_PREFIX + " Error retrieving ungrouped tabs", err);
        throw err;
    }

    for (let i = 0; i < ungroupedTabs.length; i++)
    {
        const ungroupedTab = ungroupedTabs[i];

        try
        {
            await chrome.tabs.move(ungroupedTab.id, { index: ALIGN.RIGHT });
        }
        catch (err)
        {
            console.error(`Failed to move ungrouped tab ${ungroupedTab.id}`, err);
            throw err;
        }
    };

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
        console.log(`${CONSOLE_PREFIX} Tab ${tab.id}, window ${tab.windowId} is ungrouped and compactOnActivateUngroupedTab is false.  Taking no further action.`);
        return;
    }

    let thisWindowData = getWindowData(tab.windowId);

    // commented out because we still want to collapse any open but not active groups
    /*
    if (tab.groupId === thisWindowData.groupActiveDuringLastCompactId)
    {
        console.log(`${CONSOLE_PREFIX} Tab ${tab.id}, window ${tab.windowId}, group ${tab.groupId} is in the active group.  Taking no further action.`);
        return;
    }
    */

    console.debug(`${CONSOLE_PREFIX} Tab ${tab.id}, window ${tab.windowId}, group ${tab.groupId}. Scheduling compact for the window...`);


    // clear any pending operation timers on the current tab's window
    cancelCompactTimer(tab.windowId);

    console.debug(`${CONSOLE_PREFIX} Scheduling action timer for window ${tab.windowId} in ${delayMs}ms...`);

    // schedule the collapse-and-move operation
    thisWindowData.compactTimer = setTimeout(async () =>
    {
        // delete the timer as we're now running
        thisWindowData.compactTimer = null;

        try
        {
            await compactGroups(tab);
        }
        catch (err)
        {
            console.error(CONSOLE_PREFIX + " compactGroups() failed:", err);
        }

    }, delayMs);

}


// test to see if a new tab is (likely to be) a 'fallback' tab: a tab that was automatically created because the user
// collapsed all tab groups in the window and there were no ungrouped tabs
// also returns true if user just created a new window (with this single tab)
//
async function isFallbackTab(newTab)
{
    // `newTab` is the tab object to examine (probably a newly created tab).
    // callback is sent true if the window consists only of this tab (ungrouped) and 0 or more collapsed tab groups

    if (!newTab)
    {
        console.error(CONSOLE_PREFIX + " No new tab provided to isFallbackTab");
        return false;
    }

    // populate: true, ensure that the .tabs property of the win object is filled
    let win;
    try
    {
        win = await chrome.windows.get(newTab.windowId, { populate: true });
    }
    catch (err)
    {
        console.error(`${CONSOLE_PREFIX} Error retrieving window with ID ${newTab.windowId} for tab:`, err);
        return false;
    }

    let otherTabs = win.tabs.filter(tab => tab.id !== newTab.id);

    if (otherTabs.length === 0)
    {
        // window contains only the new tab
        // effectively this is a fallback tab
        return true;
    }
    else
    {
        // Separate tabs that are not in any group
        let ungroupedTabs = otherTabs.filter(tab => tab.groupId === chrome.tabGroups.TAB_GROUP_ID_NONE);

        if (ungroupedTabs.length > 0)
        {
            // some other tabs are not in any tab group
            return false;
        }
        else
        {
            // Collect the unique group IDs from the remaining tabs.
            let groupIds = [...new Set(otherTabs.map(tab => tab.groupId))];

            // Now query the tab groups in this window to verify their collapsed state.
            let groups = await chrome.tabGroups.query({ windowId: win.id });

            let allCollapsed = true;

            // this can probably be more efficient
            for (let i = 0; i < groupIds.length; i++)
            {
                let gid = groupIds[i];
                let group = groups.find(g => g.id === gid);
                if (!group)
                {
                    console.error(`${CONSOLE_PREFIX} Group ${gid} not found.`);
                    continue;
                }
                if (!group.collapsed)
                {
                    allCollapsed = false;
                    break;
                }
            }

            if (allCollapsed)
            {
                // window contains only collapsed tab groups and the new tab
                // therefore this new tab is (probably) a fallback tab
                return true;
            }
            else
            {
                // some tab groups are expanded
                return false;
            }

        }
    }

}


// define our listeners

// Listen for messages from content scripts
//
function onRuntimeMessage(message, sender, sendResponse)
{

    //return;

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
            else if (!contentTab.active)
            {
                console.error(CONSOLE_PREFIX + ' Mouse somehow ' + (isMouseInContentArea ? 'entered' : 'left') + ' the content area of a non-active tab - witchcraft?!', contentTab);
                sendResponse({ status: "failed" });
                return;
            }
            else if (isMouseInContentArea)
            {
                console.debug(CONSOLE_PREFIX + ' Mouse entered contentTab', contentTab);

                let winData = getWindowData(contentTab.windowId);

                if (contentTab.groupId === winData.groupActiveDuringLastCompactId)
                {
                    // console.debug(CONSOLE_PREFIX + ' Tab is already in the active group - taking no further action');
                    // we DO need to take action to at least do the collapsing of groups, even though we know we don't need to move
                    //return;
                }

                scheduleCompactOtherGroups(contentTab, userOptions.delayCompactOnEnterContentAreaMs);
            }
            else  // isMouseInContentArea is false
            {
                console.debug(CONSOLE_PREFIX + ' Mouse left contentTab', contentTab);

                // we cancel all the collapse operations in case they went back up to the tab list
                cancelCompactTimer(contentTab.windowId);
            }

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
    console.log(`${CONSOLE_PREFIX} >>> Activated uninjectable tab ${tabId}...`);

    chrome.tabs.get(tabId, (activeTab) =>
    {
        if (chrome.runtime.lastError)
        {
            console.error(`${CONSOLE_PREFIX} Failed to get activated tab ${activeInfo.tabId}`, chrome.runtime.lastError);
            return;
        }

        let winData = getWindowData(activeTab.windowId);

        if (winData.newTabId === activeTab.id)
        {
            console.log(CONSOLE_PREFIX + " Ignoring first activation of newly created tab", activeTab.id)
            winData.newTabId = null;
            return;
        }

        scheduleCompactOtherGroups(activeTab, userOptions.delayCompactOnActivateUninjectedTabMs);
    });
}

// Listen for tab activation to schedule collapse of non-active groups
// used as a fallback to trigger compaction when the content script
//   can't be injected into the active tab's content pane
//
function onTabActivated(activeInfo)
{
    if (!activeInfo.windowId)
    {
        console.error(CONSOLE_PREFIX + ' no windowId in onTabActivated');
        return;
    }

    let thisWinData = getWindowData(activeInfo.windowId);
    thisWinData.lastActiveTabId = activeInfo.tabId;
    saveWindowData();

    console.debug(CONSOLE_PREFIX + " >>> onActivated tab id:", activeInfo.tabId);

    isContentScriptActive(activeInfo.tabId).then((isInjected) =>
    {
        if (isInjected)
        {
            console.debug(`${CONSOLE_PREFIX} Activated tab ${activeInfo.tabId} already has content script injected`);

            // we might have triggered a collapse-and-move from clicking a system tab and then have switched to this tab
            // so we cancel any ticking timers
            cancelCompactTimer(activeInfo.windowId);
            return;
        }

        if (!DYNAMIC_INJECTS)
        {
            console.log(`${CONSOLE_PREFIX} Activated tab ${activeInfo.tabId} has no content script injected and dynamic injects are disabled`);
            onActivateUninjectableTab(activeInfo.tabId);
            return;
        }

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

    });
}


// Listen for when a tab is updated, in particular when moved into a new group
// fallback for if the content script cannot be injected into the tab contents
//
function onTabUpdated(tabId, changeInfo)
{
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
    if (!userOptions.autoGroupNewTabs)
    {
        return;
    }

    // we immediately grab this before onActivated runs for this tab and updates it with this new tab's ID
    let lastActiveTabId = getWindowData(newTab.windowId).lastActiveTabId;

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

    setTimeout(() =>
    {
        // refetch the tab to check for updates
        chrome.tabs.get(newTab.id)
            .then((newTab) =>
            {
                // If tab has NOW been assigned a group, skip grouping
                if (newTab.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE)
                {
                    console.log(`${CONSOLE_PREFIX} Tab ${newTab.id} has been placed into group ${newTab.groupId} since its creation (probably by browser)`);
                    return;
                }

                // when the user collapses all tab groups in a window in which there are no other tabs,
                // the browser will auto create a new ungrouped 'fallback' tab which should be left ungrouped
                isFallbackTab(newTab)
                    .then((isFallback) =>
                    {
                        // NB: the previous `newTab` will be overwritten with the updated one

                        if (isFallback)
                        {
                            console.log(CONSOLE_PREFIX + " Ignoring fallback tab")
                            return;
                        }

                        if (lastActiveTabId)
                        {
                            if (lastActiveTabId === newTab.id)
                            {
                                console.warn(CONSOLE_PREFIX + " New tab is the also the last active tab in the window.");
                                return;
                            }

                            // retrieve the last active tab in this window (before this new tab)
                            chrome.tabs.get(lastActiveTabId)
                                .then((prevActiveTab) =>
                                {
                                    if (prevActiveTab && prevActiveTab.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE)
                                    {
                                        console.log(`${CONSOLE_PREFIX} Adding new tab (${newTab.id}) to group of last tab (${prevActiveTab.groupId})`);

                                        // Add the new tab to the group of the last focused tab
                                        // NOTE: this will trigger the onUpdated event and therefore run collapseOtherGroups()
                                        chrome.tabs.group({ groupId: prevActiveTab.groupId, tabIds: newTab.id })
                                            .catch((err) =>
                                            {
                                                console.error(CONSOLE_PREFIX + " Error grouping new tab", err);
                                            });
                                    }
                                    else
                                    {
                                        console.log(CONSOLE_PREFIX + " No group found for last active tab " + prevActiveTab.id);
                                    }
                                })
                                .catch((err) =>
                                {
                                    console.error(`${CONSOLE_PREFIX} Error retrieving tab ${lastActiveTabId}: `, err);
                                    return;
                                });
                        }
                        else
                        {
                            // maybe a brand new window.  just let the new tab be where it is
                            console.log(CONSOLE_PREFIX + " No last focused tab found for window " + newTab.windowId);
                        }

                    });

            }).catch((err) =>
            {
                console.error(CONSOLE_PREFIX + " Error 're-getting' tab:", err);
                return;
            });

    }, CHECK_GROUPING_DELAY_ON_CREATE_TAB_MS); // we pause to give the browser time to potentially move the tab into a new group if applicable

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
                console.log(`${CONSOLE_PREFIX} storage updating ${changedPropertyName} to`, changes[changedPropertyName].newValue);
                userOptions[changedPropertyName] = changes[changedPropertyName].newValue;
            }
            else
            {
                // an item was removed from the storage
                console.log(`${CONSOLE_PREFIX} storage removing: ${changedPropertyName}`);
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
    //getWindowData(newWindow.id);  // no need to initialise, getWindowData() will create
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
    console.log(CONSOLE_PREFIX + 'Service worker is being suspended/stopped.  Sayonara!  o/');
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


// activate the extension
//
function startUp()
{
    console.log(CONSOLE_PREFIX + " >>>>>>>>>>>>>> Starting up...");
    registerListeners();
    browserStartingUp = false;

    chrome.storage.local.get(['windowData'])
        .then((result) =>
        {
            if (result.windowData)
            {
                console.log(CONSOLE_PREFIX + " Retrieved windowData from local storage", result.windowData);

                // look at all the current windows
                chrome.windows.getAll({ populate: false, windowTypes: ['normal'] }).then((allWindows) =>
                {
                    const allWindowIds = allWindows.map(win => win.id);

                    // if a window just happens to have the same ID as a previously closed window
                    // i don't think there's a lot we can do

                    // filter out all entries for windows that no longer exist
                    globalWindowDataMap = new Map(result.windowData.filter(([winId, winData]) =>
                    {
                        if (allWindowIds.includes(winId))
                        {
                            return true;
                        }
                        console.warn(CONSOLE_PREFIX + " Window vanished since last windowData save: ", winId);
                        return false;
                    }));

                    allWindows.forEach((win) =>
                    {
                        getWindowData(win.id);  // this will initialise windowData objects for any window with IDs not already present
                    });

                    saveWindowData();  // save the pruned and initialised windowData back to local storage
                    console.log(CONSOLE_PREFIX + " Finished pruning and initialising globalWindowDataMap:", globalWindowDataMap);

                });

            }
            else
            {
                console.warn(CONSOLE_PREFIX + " Empty windowData found in local storage. Ignoring");
            }
        })
        .catch((err) =>
        {
            console.error(CONSOLE_PREFIX + " Failed to retrieve windowData from local storage:", err);
        })

}


// ====================================================
// ====================================================
// ====================================================


// Stop console.debug() working if we're not debugging
if (!SHOW_DEBUG_CONSOLE_MSGS)
{
    console.debug = () => { };
}

let browserStartingUp = false;


// Delay starting extension logic for a short while to avoid messing while
// the browser restores windows, tabs, and groups from a previous session
// Fired when a profile that has this extension installed first starts up
chrome.runtime.onStartup.addListener(() =>
{
    // Initialization code for startup scenarios
    console.log(CONSOLE_PREFIX + " >>> Browser is in process of starting up.  Sleeping for " + LISTEN_DELAY_ON_BROWSER_STARTUP_MS + " ms before extension startup.");
    // FIXME: we should wait until all windows have loaded, not just a fixed time

    browserStartingUp = true;  // this will stop our first setTimeout() from progressing
    setTimeout(startUp, LISTEN_DELAY_ON_BROWSER_STARTUP_MS);
});


// remove that old key
chrome.storage.sync.remove('doCompactOnActivateUngroupedTab');


// populate userOptions from the sync extension storage
chrome.storage.sync.get(DEFAULT_OPTIONS).
    then((options) =>
    {
        userOptions = options;
        console.log(CONSOLE_PREFIX + " Options read from storage:", userOptions);
    });


setTimeout(() =>
{
    if (!browserStartingUp)
    {
        console.log(CONSOLE_PREFIX + " >>> Timed out waiting for onStartup event.  Assuming browser isn't starting up.");
        startUp();
    }
}, ON_STARTUP_WAIT_TIMEOUT_MS);


console.log(`${CONSOLE_PREFIX} Tab Groups Plus v${chrome.runtime.getManifest().version} service worker has started.`);

/*
console.debug("this is console.debug", console); // shows with chromium "Verbose"
console.log("this is console.log", console);     // shows with chromium "Info"
console.info("this is console.info", console);   // shows with chromium "Info"
console.warn("this is console.warn", console);   // shows with chromium "Warnings"
console.error("this is console.error", console); // shows with chromium "Errors"
*/