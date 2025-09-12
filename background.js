// Tab Groups Plus
// background script (service worker)

// FIXME: right clicking an open tab group and clicking "Close Group" sometimes crashes browser!

// FIXME: left aligning collapsed groups when there's ungrouped tabs on the tab bar
// causes them to be positioned between the collapsed groups and the active expanded group which is weird
// probably want all the ungrouped tabs aligned to the opposite side?

// TODO: option to auto close idle tab broups (not just collapse the group, actually close it)

// TODO: on focusing a new tab, don't take any action if the active group hasn't changed

// TODO: for any process, fetch the tab object and pass it around rather than just the tab ID (but only when necessary)

import { ALIGN, DEFAULT_OPTIONS, CONSOLE_PREFIX } from './shared.js';

// timeout for receiving the browser's onStartup event
const ON_STARTUP_WAIT_TIMEOUT_MS = 500;

// time to wait before listening for events if browser is starting up
const LISTEN_DELAY_ON_BROWSER_STARTUP_MS = 5000;

// time to wait after a new tab is created before checking its group
// (the reason for this is that the browser may move the tab into a group
// automatically very shortly after its creation)
const CHECK_GROUPING_DELAY_ON_CREATE_TAB_MS = 250;

// enable/disable debug console messages
const SHOW_DEBUG_CONSOLE_MSGS = true;

// enabled requires setting "host_permissions" in manifest.json
const DYNAMIC_INJECTS = true;

// store user options from the storage in this object
let userOptions = {};


//
// ****************************************************************************************
// TODO: consider just making this map from windowId to a group pos ID
// and then on compactGroups(), assume the previously active group is in the leftmost/rightmost position
// ****************************************************************************************

// maps window ID to data about that window (see newWindowDataObj below)
const windowData = new Map();


// example of data structure within the windowData map defined above
// this is used as a template/'constructor' for new window data objects
const newWindowDataObj = {

    // the group ID of the group that was active when compactGroups() last ran
    activeGroupId: chrome.tabGroups.TAB_GROUP_ID_NONE,
    // the group position index (not tab index) the group used to have before it was activated, and moved by this extension
    activeGroupOldPos: null,

    // ID of last active tab, used when a new tab is created in order to add it to the group of this (previously active) tab
    lastActiveTabId: null,

    // set to the ID of a new tab so that onActivate and onCreate don't stomp on each other
    newTabId: null,

    // setTimeout timer object for the compact operation
    compactTimer: null
};



// ============================================================================
// ============================================================================
// ============================================================================


// retrieve data for a window, creating a new entry if necessary
// FIXME: windowData is never deleted when a window is closed
function getWindowData(windowId)
{
    try
    {
        if (!windowData.has(windowId))
        {
            windowData.set(windowId, { ...newWindowDataObj });
            console.log(`${CONSOLE_PREFIX} Initialized windowData entry for window ${windowId}`);
        }
        return windowData.get(windowId);
    }
    catch (err)
    {
        console.error(`${CONSOLE_PREFIX} getWindowData failed:`, err);
        throw err;
    }
}


// check if our content script has been injected into the tab with id `tabId`
// content script cannot inject into certain content, e.g. "about:blank", Google Web Store, browser settings, etc
// promise returns true if the content script responds to a ping, false otherwise
//
// TODO: make this async function?
//
function isContentScriptActive(tabId)
{
    // no reject() needed as any error is just a false
    return new Promise((resolve) =>
    {
        chrome.tabs.sendMessage(tabId, { action: "ping" }, (response) =>
        {
            if (chrome.runtime.lastError)
            {
                resolve(false);
            }
            resolve(true);
        });
    });
}



// returns a promise to return an array of tab groups in a window
// in the order that they are displayed (left-to-right)
// excluding the group with ID 'excludeId'
// (pass chrome.tabGroups.TAB_GROUP_ID_NONE for `excludeId` if you don't want to exclude any group)
//
// TODO: make this async function?
//
function getTabGroupsOrdered(windowId, excludeId)
{
    return new Promise((resolve, reject) =>
    {
        console.debug(`${CONSOLE_PREFIX} Running getTabGroupsOrdered(${windowId}, ${excludeId})`);

        // grab all the tabs in the window (will be sorted by left->right position)
        chrome.tabs.query({ windowId: windowId }, (tabs) =>
        {
            if (chrome.runtime.lastError)
            {
                reject(new Error(chrome.runtime.lastError.message));
            }

            const groupIdsOrdered = [];
            let lastSeenGroupId = chrome.tabGroups.TAB_GROUP_ID_NONE;

            tabs.forEach((tab) =>
            {
                if (tab.groupId === chrome.tabGroups.TAB_GROUP_ID_NONE ||
                    tab.groupId === lastSeenGroupId)
                {
                    // ignore ungrouped tabs
                    // and tabs in the same group as the previously examined tab
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

            // create a promise that resolves when all the getGroupPromises resolve
            Promise.all(getGroupPromises)
                // wait for that promise to resolve
                .then((groups) =>
                {
                    // i think ChatGPT might have overengineered this because Promise.all()
                    // should return the results in the same order as the input iterable anyway

                    // groups is now a list of tab group objects
                    // possible in incorrect order

                    // create a new list of these groups but in the same order as the IDs given in groupIdsOrdered
                    const groupsOrdered = groupIdsOrdered.map(
                        id => groups.find(group => group.id === id)
                    );

                    resolve(groupsOrdered);  // resolve refers to the main getTabGroupsOrdered() function promise
                })
                .catch((error) =>
                {
                    reject(error);  // reject refers to the the main getTabGroupsOrdered() function promise
                });

        });
    });
}


// cancel any action timers set for the supplied window ID
//
function cancelCompactTimer(windowId)
{
    let winData = getWindowData(windowId);

    if (winData.compactTimer)
    {
        clearTimeout(winData.compactTimer);
        winData.compactTimer = null;
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
        console.error(`${CONSOLE_PREFIX} Error querying tabs:`, error);
        return null;
    }
}


// returns a promise that collapses all tab groups in a window except the one with group ID `excludeGroupId`
// if you want to collapse all groups, pass chrome.tabGroups.TAB_GROUP_ID_NONE for excludeGroupId
function collapseWindowGroups(windowId, excludeGroupId)
{
    return new Promise((resolve, reject) =>
    {
        chrome.tabGroups.query({ windowId: windowId, collapsed: false }, (groups) =>
        {
            if (chrome.runtime.lastError)
            {
                console.error(`${CONSOLE_PREFIX} Failed to query tabs of window ${activeTab.windowId}`, chrome.runtime.lastError.message);
                reject(new Error(`Failed to query tabs of window ${activeTab.windowId}: ${chrome.runtime.lastError.message}`))
            }

            let groupIds = groups.map(group => group.id);

            if (excludeGroupId !== chrome.tabGroups.TAB_GROUP_ID_NONE)
            {
                // filter out the excluded group ID
                // this seems inefficient way of doing it as a separate step
                groupIds = groupIds.filter(id => id !== excludeGroupId);
            }

            const collapseGroupPromises = groupIds.map(groupId => chrome.tabGroups.update(groupId, { collapsed: true }));
            // now collapseGroupPromises is a list of promises to collapse each uncollapsed group in the window

            Promise.all(collapseGroupPromises)
                .then(() =>
                {
                    resolve();
                }).catch((error) =>
                {
                    // one or more collapse operations failed
                    console.error(`${CONSOLE_PREFIX} Failed to collapse one or more groups in window ${windowId}`, error);
                    reject(new Error(`Failed to collapse one or more groups in window ${windowId}: ${error}`));
                });

        })

    });

}


// async helper function for scheduleCompactOtherGroups()
// `activeTab` represents the current active tab of the window (or at least it should be active!)
//
async function compactGroups(activeTab)
{
    console.log(CONSOLE_PREFIX + " >>> Compacting groups for window " + activeTab.windowId + ", active tab is:", activeTab);

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


    // ==================================================================
    // (1) collapse all the inactive groups
    // ==================================================================
    console.log(CONSOLE_PREFIX + " ==== (1) Collapsing inactive groups...");

    // fetch the IDs of all OTHER groups in this window (excluding the active tab's group) in left-to-right order
    // its possible that activeTab.groupId is TAB_GROUP_ID_NONE (-1) if the active tab is ungrouped
    // which will mean that ALL groups are considered inactive

    await collapseWindowGroups(activeTab.windowId, activeTab.groupId).catch((err) =>
    {
        console.error(CONSOLE_PREFIX + " Failed to collapse inactive groups", err);
        // we continue...
    });


    // we've now collapsed (or tried to collapse) all the groups except the active one

    // if we are not configured to aligni the active tab group after collapsing, we're done
    if (userOptions.alignActiveTabGroup === ALIGN.DISABLED)
    {
        console.log(CONSOLE_PREFIX + " Aligning of active tab group is disabled.  All done");
        return;
    }


    // ==================================================================
    // (2) restore the position of the *previously* active group (if there is one)
    // ==================================================================
    console.log(CONSOLE_PREFIX + " ==== (2) Restoring position of previously active group...");

    // prepare to start moving groups around
    const thisWindowData = getWindowData(activeTab.windowId);

    console.log(CONSOLE_PREFIX + " thisWindowData:", thisWindowData);

    // NOTE:
    // this function has been called because the active tab has changed
    // thisWindowData.activeGroupId now refers to the *previously* active tab group's ID!
    // thisWindowData.activeGroupOldPos now refers to the *previously* active tab group's *previous* position that we now want to move it back to
    //   so let's create some more sensible variable names...
    let prevActiveGroupId = thisWindowData.activeGroupId;
    let prevActiveGroupOldPos = thisWindowData.activeGroupOldPos;

    let tabIndexToMoveTo = null;

    if (prevActiveGroupOldPos !== null && prevActiveGroupId !== chrome.tabGroups.TAB_GROUP_ID_NONE)
    {
        let prevActiveGroup = null;
        try
        {
            prevActiveGroup = await chrome.tabGroups.get(prevActiveGroupId);
        }
        catch (err)
        {
            console.error(`${CONSOLE_PREFIX} Failed to retrieve previously active group with ID ${prevActiveGroupId}.`, err);
            return;
        }

        console.log(`${CONSOLE_PREFIX} Group previously active and previously at group index ${prevActiveGroupOldPos}:`, prevActiveGroup);

        // retrieve ALL tab groups in this window in left-to-right order
        const groupsOrdered = await getTabGroupsOrdered(activeTab.windowId, chrome.tabGroups.TAB_GROUP_ID_NONE)
            .catch((err) =>
            {
                console.error(`${CONSOLE_PREFIX} Failed to retrieve ordered tab groups in window ${activeTab.windowId}`, err);
                return;
            });

        // retrive the tab group that's currently occupying the group pos index where the previously active group was
        if (groupsOrdered[prevActiveGroupOldPos] !== null)
        {
            // there's a group located in the group index pos where we want to return this group
            // this group will be bumped one place to the right after the move

            // fetch the tab index of the first tab of the group that's currently at this group index position
            tabIndexToMoveTo = await getIndexOfFirstTabInGroup(groupsOrdered[prevActiveGroupOldPos]);
        }
        else
        {
            // this might happen if the user has closed some groups or moved them into a different window
            console.warn(CONSOLE_PREFIX + " No group currently at this location.  Moving to rightmost position.");

            // just move this group to the rightmost position
            tabIndexToMoveTo = ALIGN.RIGHT;
        }


        if (null !== tabIndexToMoveTo)  // proper null test necesary, tabIndexToMoveTo could be 0 and valid
        {
            // move the group to the new location
            /*
            try {
                await new Promise((resolve, reject) =>
                {
                    chrome.tabGroups.move(prevActiveGroup.id, { index: tabIndexToMoveTo }, (movedGroup) =>
                    {
                        if (chrome.runtime.lastError)
                        {
                            // FIXME: getting "Cannot move the group to an index that is in the middle of another group."
                            console.error(`${CONSOLE_PREFIX} Failed restoring previously active group ${prevActiveGroup.title} to tab index ${tabIndexToMoveTo}`, chrome.runtime.lastError.message);
                            reject(new Error(`Failed restoring previously active group ${prevActiveGroup.title} to tab index ${tabIndexToMoveTo}: ${chrome.runtime.lastError.message}`));
                        }
                        resolve();
                    });
                });
            } catch (err) { ... }
            */

            try
            {
                await chrome.tabGroups.move(prevActiveGroup.id, { index: tabIndexToMoveTo });
            }
            catch (err)
            {
                console.warn(`${CONSOLE_PREFIX} Failed restoring previously active group ${prevActiveGroup.title} to tab index ${tabIndexToMoveTo}`, err);
                // we continue...
            }

        }

        // we've now returned (or failed to return) the previously active group
        // into the correct place so we clear the record
        thisWindowData.activeGroupId = chrome.tabGroups.TAB_GROUP_ID_NONE;
        thisWindowData.activeGroupOldPos = null;
    }
    else
    {
        console.warn(CONSOLE_PREFIX + " No previously active group to restore");
    }



    if (activeTab.groupId === chrome.tabGroups.TAB_GROUP_ID_NONE)
    {
        console.log(`${CONSOLE_PREFIX} Active tab is ungrouped.  All done`);
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
        thisWindowData.activeGroupOldPos = groupsOrdered.findIndex((group) =>
        {
            return group && group.id === activeTab.groupId;
        });
        thisWindowData.activeGroupId = activeTab.groupId;
    }
    catch (err)
    {
        console.error(`${CONSOLE_PREFIX} Failed to retrieve ordered tab groups in window ${activeTab.windowId}.  Resetting windowData`, err);
        thisWindowData.activeGroupId = chrome.tabGroups.TAB_GROUP_ID_NONE;
        thisWindowData.activeGroupOldPos = null;
    }

    console.log(`${CONSOLE_PREFIX} Updated windowData:`, thisWindowData);

    // ==================================================================
    // (4) position the new active `group` to the very left or very right
    // ==================================================================
    console.log(CONSOLE_PREFIX + " ==== (4) Aliging active group to leftmost/rightmost...");

    /*
    await new Promise((resolve, reject) =>
    {
        // userOptions.alignActiveGroup will be either 0 (Align.LEFT) or -1 (Align.RIGHT)
        chrome.tabGroups.move(activeTab.groupId, { index: userOptions.alignActiveTabGroup }, (movedGroup) =>
        {
            if (chrome.runtime.lastError)
            {
                reject(new Error(`Failed to align active group ${group.id}: ${chrome.runtime.lastError}`));
            }
            resolve();
        });
    });
    */
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
        // is this list sorted in left-to-right order?
        ungroupedTabs = await chrome.tabs.query({ windowId: activeTab.windowId, groupId: chrome.tabGroups.TAB_GROUP_ID_NONE });
    }
    catch (err)
    {
        console.error(CONSOLE_PREFIX + " Error retrieving ungrouped tabs", err);
        throw err;
    }
    /*
    if (userOptions.alignActiveTabGroup === ALIGN.RIGHT)
    {
        // process ungrouped tabs in right-to-left order as we move them to the leftmost position
        ungroupedTabs.reverse();
    }
    */

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

// schedule a collapse-and-move operation on all other tab groups in the window
// apart from the group of the given "tab"
//
function scheduleCompactOtherGroups(tab, delayMs)
{
    // as things stand, tab is active but the other groups have not been collapsed
    // nor has this active tab's group been moved around

    if (tab.groupId === chrome.tabGroups.TAB_GROUP_ID_NONE)
    {
        if (!userOptions.doCompactOnActivateUngroupedTab)
        {
            console.log(`${CONSOLE_PREFIX} Tab ${tab.id}, window ${tab.windowId} is ungrouped and doCompactOnActivatingUngroupedTab is false.  Taking no further action.`);
            return;
        }
    }

    let thisWinData = getWindowData(tab.windowId);

    if (tab.groupId === thisWinData.activeGroupId)
    {
        console.log(`${CONSOLE_PREFIX} Tab ${tab.id}, window ${tab.windowId}, group ${tab.groupId} is in the active group.  Taking no further action.`);
        return;
    }

    console.debug(`${CONSOLE_PREFIX} Tab ${tab.id}, window ${tab.windowId}, group ${tab.groupId}. Scheduling compact for the window...`);


    // clear any pending operation timers on the current tab's window
    cancelCompactTimer(tab.windowId);

    console.debug(`${CONSOLE_PREFIX} Scheduling action timer for window ${tab.windowId} in ${delayMs}ms...`);

    let winData = getWindowData(tab.windowId);


    // schedule the collapse-and-move operation
    winData.compactTimer = setTimeout(async () =>
    {
        // delete the timer as we're now running
        winData.compactTimer = null;

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
// FIXME: why does this need a callback param?  why not just return true/false?  i think we just need the function to be async
// so that it can await the async chrome.windows and chrome.tabs stuff
function isFallbackTab(newTab, callback)
{
    // `newTab` is the tab object to examine (probably a newly created tab).
    // callback is sent true if the window consists only of this tab (ungrouped) and 0 or more collapsed tab groups

    if (!newTab)
    {
        console.error(CONSOLE_PREFIX + " No new tab provided to isFallbackTab");
        callback(false);
        return false;
    }

    // populate: true, ensure that the .tabs property of the win object is filled
    chrome.windows.get(newTab.windowId, { populate: true }, (win) =>
    {
        if (chrome.runtime.lastError)
        {
            console.error(`${CONSOLE_PREFIX} Error retrieving window with ID ${newTab.windowId} for tab:`, chrome.runtime.lastError);
            callback(false);
            return false;
        }

        let otherTabs = win.tabs.filter(tab => tab.id !== newTab.id);

        if (otherTabs.length === 0)
        {
            // window contains only the new tab
            // effectively this is a fallback tab
            callback(true);
            return true;
        }
        else
        {
            // Separate tabs that are not in any group
            let nonGroupedTabs = otherTabs.filter(tab => tab.groupId === chrome.tabGroups.TAB_GROUP_ID_NONE);

            if (nonGroupedTabs.length > 0)
            {
                // some other tabs are not in any tab group
                callback(false);
                return false;
            }
            else
            {
                // Collect the unique group IDs from the remaining tabs.
                let groupIds = [...new Set(otherTabs.map(tab => tab.groupId))];

                // Now query the tab groups in this window to verify their collapsed state.
                chrome.tabGroups.query({ windowId: win.id }, groups =>
                {
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
                        callback(true);
                        return true;
                    }
                    else
                    {
                        // some tab groups are expanded
                        callback(false);
                        return false;
                    }
                });
            }
        }
    });
}


// define our listeners

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

                if (contentTab.groupId === winData.activeGroupId)
                {
                    console.log(CONSOLE_PREFIX + ' Tab is already in the active group - taking no further action');
                    return;
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
    console.warn(`${CONSOLE_PREFIX} >>> Activated uninjectable tab ${tabId}...`);

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
            console.warn(`${CONSOLE_PREFIX} Activated tab ${activeInfo.tabId} has no content script injected and dynamic injects are disabled`);
            onActivateUninjectableTab(activeInfo.tabId);
            return;
        }

        // try to dynamically inject content script
        // you can comment out if DYNAMIC_INJECTS is false
        // to stop Google complaining that the manifest.json lacks 'scripting' permission
        chrome.scripting.executeScript({ target: { tabId: activeInfo.tabId }, files: ["content.js"] }, () =>
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
                        console.error(`${CONSOLE_PREFIX} Unexpected error injecting into tab ${activeInfo.tabId}:`, chrome.runtime.lastError.message);
                }

                onActivateUninjectableTab(activeInfo.tabId);
            }
            else
            {
                console.log(CONSOLE_PREFIX + " Content script injected into activated tab", activeInfo.tabId);
            }
        });

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
        chrome.tabs.get(newTab.id, (newTab) =>
        {
            if (chrome.runtime.lastError)
            {
                console.error(CONSOLE_PREFIX + " Error 're-getting' tab:", chrome.runtime.lastError);
                return;
            }

            // If tab has NOW been assigned a group, skip grouping
            if (newTab.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE)
            {
                console.log(`${CONSOLE_PREFIX} Tab ${newTab.id} has been auto-grouped into group ${newTab.groupId} (by browser?)`);
                return;
            }

            // when the user collapses all tab groups in a window in which there are no other tabs,
            // the browser will auto create a new ungrouped 'fallback' tab which shouldn't be added to a tab group
            isFallbackTab(newTab, (isFallback) =>
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
                    chrome.tabs.get(lastActiveTabId, (prevActiveTab) =>
                    {
                        if (chrome.runtime.lastError)
                        {
                            console.error(`${CONSOLE_PREFIX} Error retrieving tab ${lastActiveTabId}: `, chrome.runtime.lastError);
                            return;
                        }

                        if (prevActiveTab && prevActiveTab.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE)
                        {
                            console.log(`${CONSOLE_PREFIX} Adding new tab (${newTab.id}) to group of last tab (${prevActiveTab.groupId})`);

                            // Add the new tab to the group of the last focused tab
                            // NOTE: this will trigger the onUpdated event and therefore run collapseOtherGroups()
                            chrome.tabs.group({ groupId: prevActiveTab.groupId, tabIds: newTab.id }, () =>
                            {
                                if (chrome.runtime.lastError)
                                {
                                    console.error(CONSOLE_PREFIX + " Error grouping new tab", chrome.runtime.lastError);
                                }
                            });
                        }
                        else
                        {
                            console.log(CONSOLE_PREFIX + " No group found for last active tab " + prevActiveTab.id);
                        }
                    });
                }
                else
                {
                    // maybe a brand new window.  just let the new tab be where it is
                    console.log(CONSOLE_PREFIX + " No last focused tab found for window " + newTab.windowId);
                }

            });

        });

    }, CHECK_GROUPING_DELAY_ON_CREATE_TAB_MS); // we pause to give the browser time to potentially move the tab into a new group if applicable

}


// listen for when the options page was used to save new options in the storage
// we need to update the userOptions object to match
//
function onStorageChanged(changes, areaName)
{
    console.log(CONSOLE_PREFIX + ' >>> storage.OnChanged', changes, areaName);

    if (areaName === 'sync')
    {
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


// called when the extension is about to be unloaded
function onSuspend()
{
    deregisterListeners();
    console.log(CONSOLE_PREFIX + " Listeners deregistered");
}


// register our listeners
//
function registerListeners()
{
    chrome.runtime.onMessage.addListener(onRuntimeMessage);
    chrome.tabs.onActivated.addListener(onTabActivated);
    chrome.tabs.onUpdated.addListener(onTabUpdated);
    chrome.tabs.onCreated.addListener(onTabCreated);
    chrome.storage.onChanged.addListener(onStorageChanged);
    chrome.runtime.onSuspend.addListener(onSuspend);

    browserStartingUp = false;
    console.log(CONSOLE_PREFIX + " Listeners registered");
}


function deregisterListeners()
{
    chrome.runtime.onMessage.removeListener(onRuntimeMessage);
    chrome.tabs.onActivated.removeListener(onTabActivated);
    chrome.tabs.onUpdated.removeListener(onTabUpdated);
    chrome.tabs.onCreated.removeListener(onTabCreated);
    chrome.storage.onChanged.removeListener(onStorageChanged);
    chrome.runtime.onSuspend.removeListener(onSuspend);

    console.log(CONSOLE_PREFIX + " Listeners deregistered");
}

// Stop console.debug() working if we're not debugging
if (!SHOW_DEBUG_CONSOLE_MSGS)
{
    console.debug = () => { };
}

let browserStartingUp = false;


// Delay starting extension logic for a short while to avoid messing while
// the browser restores windows, tabs, and groups from a previous session
chrome.runtime.onStartup.addListener(() =>
{
    // Initialization code for startup scenarios
    console.log(CONSOLE_PREFIX + " >>> Browser is starting up.  Sleeping for " + LISTEN_DELAY_ON_BROWSER_STARTUP_MS + " ms before registering listeners.");
    browserStartingUp = true;
    setTimeout(registerListeners, LISTEN_DELAY_ON_BROWSER_STARTUP_MS);
});


// read userOptions
chrome.storage.sync.get(DEFAULT_OPTIONS, (options) =>
{
    userOptions = options;
    console.log(CONSOLE_PREFIX + " Options read from storage:", userOptions);
});


setTimeout(() =>
{
    if (!browserStartingUp)
    {
        console.log(CONSOLE_PREFIX + " >>> Browser doesn't seem to be starting up.  Registering listeners now.");
        registerListeners();
    }
}, ON_STARTUP_WAIT_TIMEOUT_MS);


console.log(CONSOLE_PREFIX + " Extension loaded. Waiting for browser-based onStartup event for " + ON_STARTUP_WAIT_TIMEOUT_MS + " ms...");

/*
console.debug("this is console.debug", console); // shows with chromium "Verbose"
console.log("this is console.log", console);     // shows with chromium "Info"
console.info("this is console.info", console);   // shows with chromium "Info"
console.warn("this is console.warn", console);   // shows with chromium "Warnings"
console.error("this is console.error", console); // shows with chromium "Errors"
*/