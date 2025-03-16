// Tab Groups Plus
// background script (service worker)

// FIXME: right clicking an open tab group and clicking "Close Group" sometimes crashes browser!

// FIXME: left aligning collapsed groups when there's ungrouped tabs on the tab bar
// causes them to be positioned between the collapsed groups and the active expanded group which is weird
// probably want all the ungrouped tabs aligned to the opposite side?


import { ALIGN, DEFAULT_OPTIONS, CONSOLE_PREFIX } from './shared.js';

// timeout for receiving the browser's onStartup event
const ON_STARTUP_WAIT_TIMEOUT_MS = 500;

// time to wait before listening for events if browser is starting up
const LISTEN_DELAY_ON_BROWSER_STARTUP_MS = 10000;

// time to wait after a new tab is created before checking its group
// (the browser may move the tab into a group automatically very shortly after its creation)
const CHECK_GROUPING_DELAY_ON_CREATE_TAB_MS = 250;

// enable/disable debug console messages
const SHOW_DEBUG_CONSOLE_MSGS = false;

// disabling for now so we don't have to use "host_permissions" in manifest.json
const DYNAMIC_INJECTS = true;

// user options from the storage
let userOptions = {};

// Map to store collapse/align operation timers by window id
let windowActionTimers = {};

// Map to store last focused tab id by window id
// (used when a new tab is created to then add it to the group of the previously active tab)
let lastActiveTabIds = {};

// hack to stop onActivated from stomping all over onCreated
// won't work when new tabs are created but not switched to
// e.g. when the user middle-clicks a link to open it in a new tab
// as then the next activated tab will not trigger any group collapsing
let newlyCreatedTabs = new Set();

// Map to store previous "group index" position of an active group within its window
// this index (0+) represents ordering from left-to-right considering groups only
// it's not like tab index
// e.g. activeGroupsPrevPos[42] = 2
// states that group #42 used to be in group index pos 2 (of its window)
let activeGroupsPrevPos = {};


// ============================================================================
// ============================================================================
// ============================================================================


// check if our content script has been injected on the given tab
// content script cannot inject into certain content, e.g. about:blank, Google Web Store, browser settings, etc
// promise returns true if the content script responds to a ping, false otherwise
//
function isContentScriptActive(tabId)
{
    // no reject needed
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
// (use chrome.tabGroups.TAB_GROUP_ID_NONE to not exclude any group)
//
function getTabGroupsOrdered(windowId, excludeId)
{
    return new Promise((resolve, reject) =>
    {
        // grab all the tabs in the window (will be sorted by left->right position)
        chrome.tabs.query({ windowId: windowId }, (tabs) =>
        {
            if (chrome.runtime.lastError)
            {
                reject(chrome.runtime.lastError);
            }

            const groupIdsOrdered = [];
            let groupIndex = 0;

            tabs.forEach((tab) =>
            {
                //console.debug(CONSOLE_PREFIX + 'getTabGroupsOrdered retrieved', tab);

                if (tab.groupId === chrome.tabGroups.TAB_GROUP_ID_NONE)
                {
                    return; // ungrouped; process next tab
                }

                if (tab.groupId == excludeId)
                {
                    // this is the excluded group, i.e the one that contains the active tab
                    // group may soon end up in the leftmost/rightmost position so save the group index
                    if (!activeGroupsPrevPos[tab.groupId])
                    {
                        console.warn(`${CONSOLE_PREFIX}Active group ${tab.groupId} currently has group index ${groupIndex} - saving`);
                        activeGroupsPrevPos[tab.groupId] = groupIndex;
                        groupIndex++;
                    }
                    return;  // process next tab
                }

                if (!groupIdsOrdered.includes(tab.groupId))
                {
                    // if we haven't yet got this group ID, add it to list
                    //console.warn(`${CONSOLE_PREFIX}Storing group ${tab.groupId} into groupIdsOrdered`);
                    groupIdsOrdered.push(tab.groupId);
                    groupIndex++;
                }

            });

            // create array of promises to retrieve each tab group, in same order as in groupIdsOrdered
            // creates a list of Promises that retrieve each specific tab group
            const promises = groupIdsOrdered.map(groupId => chrome.tabGroups.get(groupId));

            // now we need to create a list of groups in the same order as these IDs
            Promise.all(promises)
                .then((groups) =>
                {
                    //console.warn(CONSOLE_PREFIX + "groups:", groups);
                    const groupsOrdered = groupIdsOrdered.map(
                        id => groups.find(group => group.id === id)
                    );
                    //console.warn(CONSOLE_PREFIX + "groupsOrdered:", groupsOrdered);
                    resolve(groupsOrdered);  // resolve refers to the main function promise
                })
                .catch((error) =>
                {
                    reject(error);  // reject refers to the the main function promise
                });
        });
    });
}


// cancel any action timers set for the supplied window ID
//
function cancelCollapseAndMoves(windowId)
{
    if (windowActionTimers[windowId])
    {
        clearTimeout(windowActionTimers[windowId]);
        delete windowActionTimers[windowId];
        console.log(`${CONSOLE_PREFIX}Cleared action timer for window ${windowId}`);
    }
}


// get the tab index of the first tab in a group
//
async function getFirstTabIndexInGroup(group)
{
    try
    {
        // Query all tabs in the specified group
        const tabs = await chrome.tabs.query({ groupId: group.id });

        if (tabs.length === 0)
        {
            console.warn("No tabs found in group '" + group.title + "' bit weird", group);
            return null;
        }

        // Find the tab with the minimum index - not necessary
        // but I'm leaving the code here cos I think it's cool
        const firstTab = tabs.reduce((minTab, currentTab) =>
        {
            return (currentTab.index < minTab.index) ? currentTab : minTab;
        });
        //const firstTab = tabs[0];

        return firstTab.index;
    }
    catch (error)
    {
        console.error(`Error querying tabs: ${error}`);
        return null;
    }
}


// async helper function for the main collapseAndMoveOtherGroups() function
// groups represents all groups apart from the active group
//
async function doCollapseAndMoveGroups(groups)
{
    // when aligning them to the left,
    // in order to preserve the order, we need to move the rightmost group to the left, then the one to the left of it, etc etc.
    // so we process in reverse (right-to-left order)
    if (userOptions.alignTabGroupsAfterCollapsing == ALIGN.LEFT)
    {
        console.log(CONSOLE_PREFIX + "Aligning tab groups to the left so reversing groups[]");
        groups.reverse();
    }

    let groupsToRestore = [];
    let indexToMoveTo = null;

    // iterate through all the groups we were given
    for (const group of groups)
    {
        console.debug(CONSOLE_PREFIX + "Preparing to collapse/move group", group);

        if (!group.collapsed)
        {
            console.log(CONSOLE_PREFIX + "Collapsing group:" + group);

            // Collapse group (wrapped as an awaited Promise) and wait until resolved
            await new Promise((resolve, reject) =>
            {
                chrome.tabGroups.update(group.id, { collapsed: true }, () =>
                {
                    if (chrome.runtime.lastError)
                    {
                        // we don't reject so we can continue and try other groups
                        console.error(CONSOLE_PREFIX + "Failed to collapse group " + group.title, chrome.runtime.lastError);
                        reject("Failed to collapse group " + group.id, chrome.runtime.lastError);
                    }
                    resolve();
                });
            });
        }

        if (userOptions.alignTabGroupsAfterCollapsing !== ALIGN.DISABLED)
        {
            // move the group after collapsing to align
            // NOTE: we don't move the active group, we just move all the other collapsed groups to the left or right of it

            // if this was the previously active group (that got re-aligned when made activated),
            // it needs to be restored to it's correct place
            // but we don't do this until we've moved everything else first.
            //
            // this is BAD because we need to put ourself into the correct index last
            // change this to skip over this group, add it to a job queue and then do it at the end

            if (activeGroupsPrevPos[group.id])
            {
                // deal with this at the end
                groupsToRestore.push(group);
                continue; // to next group
            }
            else
            {
                switch (userOptions.alignTabGroupsAfterCollapsing)
                {
                    case ALIGN.LEFT:
                    case ALIGN.RIGHT:
                        // the underlying int value corresponds to the position to move to (0 or -1, leftmost or rightmost
                        indexToMoveTo = userOptions.alignTabGroupsAfterCollapsing;
                        break;

                    default:
                        reject("Unexpected value for user option `alignTabGroupsAfterCollapsing`:", userOptions.alignTabGroupsAfterCollapsing);
                }

                // move the group to the new location
                await new Promise((resolve) =>
                {
                    chrome.tabGroups.move(group.id, { index: indexToMoveTo }, (movedGroup) =>
                    {
                        if (chrome.runtime.lastError)
                        {
                            reject(`Failed to move group ${group.id}: ${chrome.runtime.lastError}`);
                        }
                        resolve();
                    });
                });


            }
        }
    }

    if (userOptions.alignTabGroupsAfterCollapsing !== ALIGN.DISABLED)
    {
        // now finally restore the previously active group(s)
        // there should only be one but you never know
        for (const group of groupsToRestore)
        {
            let groupsPreviousIndex = activeGroupsPrevPos[group.id];

            console.log(CONSOLE_PREFIX + "Group previously active at index " + groupsPreviousIndex + ":", group);

            // fetch current group ordering since we might have moved other tab groups
            // this will always be in left-to-right order
            // when this call of getTabGroupsOrdered() runs, the tabs won't yet be in their correct spaces
            // and the console output therefore might be confusing
            const groupsOrdered = await getTabGroupsOrdered(group.windowId, chrome.tabGroups.TAB_GROUP_ID_NONE);

            console.warn(CONSOLE_PREFIX + "Moving back to group index " + groupsPreviousIndex + " this active group:", group);

            if (groupsOrdered[groupsPreviousIndex])
            {
                // there's currently a group located in the group index pos where we want to return this group
                // this would only not be the case if tab groups have been closed or moved away from this window

                // if there's a group already in this index, it will be bumped one place to the right but that's what we want

                // fetch the tab index of the first tab of the group that's currently at this group index position
                indexToMoveTo = await getFirstTabIndexInGroup(groupsOrdered[groupsPreviousIndex]);
            }
            else
            {
                // this might happen if groups have been removed
                console.error(CONSOLE_PREFIX + "No group currently at this location!");
                indexToMoveTo = null;
            }

            if (null !== indexToMoveTo)
            {
                // move the group to the new location
                await new Promise((resolve, reject) =>
                {
                    chrome.tabGroups.move(group.id, { index: indexToMoveTo }, (movedGroup) =>
                    {
                        if (chrome.runtime.lastError)
                        {
                            reject(`Failed to move group ${group.id}: ${chrome.runtime.lastError}`);
                        }
                        resolve();
                    });
                });
            }

            // we've now returned the previously active group into the correct place so we can delete the record
            delete activeGroupsPrevPos[group.id];
        }
    }
}


// collapses all other tab groups in the window apart from the group of the given "tab"
//
function collapseAndMoveOtherGroups(tab, delayMs)
{
    // as things stand, tab is active but the other groups have not been collapsed
    // nor has this active tab's group been moved around

    if (tab.groupId === chrome.tabGroups.TAB_GROUP_ID_NONE)
    {
        if (!userOptions.collapseOthersWithGrouplessTab)
        {
            console.log(CONSOLE_PREFIX + `Tab ${tab.id}, window ${tab.windowId} is ungrouped and collapseOthersWithGrouplessTab is false. Taking no further action.`);
            return;
        }
        console.log(CONSOLE_PREFIX + `Tab ${tab.id}, window ${tab.windowId}, group none. Scheduling collapse and move for the window...`);
    }
    else
    {
        console.log(CONSOLE_PREFIX + `Tab ${tab.id}, window ${tab.windowId}, group ${tab.groupId}. Scheduling collapse and move for the window...`);
    }

    // clear any pending operation timers on the current tab's window
    cancelCollapseAndMoves(tab.windowId);

    console.debug(CONSOLE_PREFIX + "Retrieving ordered tab groups....");

    // fetch the IDs of all groups in this window except the active group
    // in left-to-right appearance order
    getTabGroupsOrdered(tab.windowId, tab.groupId).then((groupsOrdered) =>
    {
        console.log(CONSOLE_PREFIX + `Scheduling action timer for window ${tab.windowId} in ${delayMs}ms...`);

        windowActionTimers[tab.windowId] = setTimeout(async () =>
        {
            // delete the timer as we're now running
            delete windowActionTimers[tab.windowId];

            console.log(CONSOLE_PREFIX + ">>>>>> Action timer for window " + tab.windowId + " running");
            await doCollapseAndMoveGroups(groupsOrdered);
        }, delayMs);
    });

}


// test to see if a new tab is (likely to be) a 'fallback' tab: a tab that was automatically created because the user
// collapsed all tab groups in the window and there were no ungrouped tabs
// also returns true if user just created a new window (with this single tab)
//
function isFallbackTab(newTab, callback)
{
    // `newTab` is the tab object to examine (probably a newly created tab).
    // callback is sent true if the window consists only of this tab (ungrouped) and 0 or more collapsed tab groups

    if (!newTab)
    {
        console.error(CONSOLE_PREFIX + "No new tab provided to isFallbackTab");
        callback(false);
    }

    chrome.windows.get(newTab.windowId, { populate: true }, (win) =>
    {
        if (chrome.runtime.lastError)
        {
            console.error(CONSOLE_PREFIX + "Error retrieving window for tab :", chrome.runtime.lastError);
            callback(false);
        }

        let otherTabs = win.tabs.filter(tab => tab.id !== newTab.id);

        if (otherTabs.length === 0)
        {
            // window contains only the new tab
            // effectively this is a fallback tab
            callback(true);
            return;
        }
        else
        {
            // Separate tabs that are not in any group
            let nonGroupedTabs = otherTabs.filter(tab => tab.groupId === chrome.tabGroups.TAB_GROUP_ID_NONE);

            if (nonGroupedTabs.length > 0)
            {
                // some other tabs are not in any tab group
                callback(false);
                return;
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
                            console.error(CONSOLE_PREFIX + `Group ${gid} not found.`);
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
                    }
                    else
                    {
                        // some tab groups are expanded
                        callback(false);
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
                console.warn(CONSOLE_PREFIX + 'No sender tab for mouseInContentArea event');
            }
            else if (!contentTab.active)
            {
                console.warn(CONSOLE_PREFIX + 'Mouse entered/left content area of non-active tab - what is this witchcraft?!', contentTab);
            }
            else if (isMouseInContentArea)
            {
                console.debug(CONSOLE_PREFIX + 'Mouse entered contentTab', contentTab);
                collapseAndMoveOtherGroups(contentTab, userOptions.collapseDelayOnEnterContentAreaMs);
            }
            else  // isMouseInContentArea is false
            {
                console.debug(CONSOLE_PREFIX + 'Mouse left contentTab', contentTab);

                // we cancel all the collapse operations in case they went back up to the tab list
                cancelCollapseAndMoves(contentTab.windowId);
            }
            sendResponse({ status: "ok" });
            break;

        default:
            console.error(CONSOLE_PREFIX + "Unexpected action from content script: '" + message.action + "'")
            sendResponse({ status: "invalidAction" });

    }

}


// helper function to perform when a system (uninjected) tab has been activated
//
function onActivateUninjectableTab(tabId)
{
    console.warn(`${CONSOLE_PREFIX}>>>>>> Activated uninjectable tab ${tabId}...`);

    chrome.tabs.get(tabId, (activeTab) =>
    {
        if (chrome.runtime.lastError)
        {
            console.error(CONSOLE_PREFIX + "Failed to get activated tab " + activeInfo.tabId, chrome.runtime.lastError);
            return;
        }

        if (newlyCreatedTabs.has(activeTab.id))
        {
            console.log(CONSOLE_PREFIX + "Ignoring first activation of newly created tab", activeTab.id)
            newlyCreatedTabs.delete(activeTab.id);
            return;
        }
        collapseAndMoveOtherGroups(activeTab, userOptions.collapseDelayOnActivateUninjectedTabMs);
    });
}

// Listen for tab activation to schedule collapse of non-active groups
// fallback if the content script cannot be injected into the tab contents
//
function onTabActivated(activeInfo)
{
    lastActiveTabIds[activeInfo.windowId] = activeInfo.tabId;
    console.debug(CONSOLE_PREFIX + "onActivated updated lastActiveTabIds with tab id: ", activeInfo.tabId);

    isContentScriptActive(activeInfo.tabId).then((isInjected) =>
    {
        if (isInjected)
        {
            console.log(`${CONSOLE_PREFIX}Activated tab ${activeInfo.tabId} already has content script injected`);

            // we might have triggered a collapse-and-move from clicking a system tab and then have switched to this tab
            // so we cancel any ticking timers
            cancelCollapseAndMoves(activeInfo.windowId);
            return;
        }

        if (!DYNAMIC_INJECTS)
        {
            console.warn(`${CONSOLE_PREFIX}Activated tab ${activeInfo.tabId} has no content script injected and dynamic injects disabled`);
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

                        console.warn(CONSOLE_PREFIX + "Expected error injecting into tab " + activeInfo.tabId + ":", chrome.runtime.lastError.message);
                        break;
                    // unexpected injection fails:
                    default:
                        console.error(CONSOLE_PREFIX + "Unexpected error injecting into tab " + activeInfo.tabId + ":", chrome.runtime.lastError.message);
                }

                onActivateUninjectableTab(activeInfo.tabId);
            }
            else
            {
                console.log(CONSOLE_PREFIX + "Content script injected into activated tab", activeInfo.tabId);
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
                console.log(`${CONSOLE_PREFIX}>>>>>> Injected tab ${tabId} moved to group ${changeInfo.groupId} - ignoring`)
                // we don't need to take any action on update of a tab with the content script injected
                // because the content script will collapse the tab groups on mouse entering the content area
                return;
            }

            // non-injected tab..
            if (changeInfo.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE)
            {
                // the tab wasn't made groupless
                console.log(CONSOLE_PREFIX + `>>>>>> Uninjected tab ${tabId} moved to group ${changeInfo.groupId}`);

                // fetch tab object
                chrome.tabs.get(tabId, (tab) =>
                {
                    if (chrome.runtime.lastError)
                    {
                        console.error(CONSOLE_PREFIX + "Failed to get updated tab " + tabId, chrome.runtime.lastError);
                        return;
                    }

                    // if a tab is moved into a collapsed group
                    //   if the moved tab is the active tab, the browser will automatically expand the group
                    //   if the moved tab isn't the active tab, the new group will stay collapsed
                    if (tab.active)
                    {
                        collapseAndMoveOtherGroups(tab, userOptions.collapseDelayOnActivateUninjectedTabMs);
                    }
                    else
                    {
                        console.log(CONSOLE_PREFIX + "Regrouped tab is not the active tab.  Ignoring.");
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
    // we immediately grab this before onActivated runs for this tab and updates it with this tab ID
    let lastActiveTabId = lastActiveTabIds[newTab.windowId];

    if (!userOptions.autoGroupNewTabs)
    {
        return;
    }

    console.log(`${CONSOLE_PREFIX}>>>>>> Tab created: ${newTab.id} in window ${newTab.windowId}`, newTab);

    isContentScriptActive(newTab.id).then((isInjected) =>
    {
        if (!isInjected)
        {
            // store that this is a new tab so onActivated doesn't kick in too
            // note, the code below this will run asynchronously but that's ok as
            // it's onActivated that uses newlyCreatedTabs
            newlyCreatedTabs.add(newTab.id);
        }
    });

    if (newTab.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE)
    {
        console.log(CONSOLE_PREFIX + "Newly created tab is already in a group - ignoring");
        return;
    }

    setTimeout(() =>
    {
        // refetch the tab to check for updates
        chrome.tabs.get(newTab.id, (newTab) =>
        {
            if (chrome.runtime.lastError)
            {
                console.error(CONSOLE_PREFIX + "Error 're-getting' tab:", chrome.runtime.lastError);
                return;
            }

            // If tab has NOW been assigned a group, skip grouping
            if (newTab.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE)
            {
                console.log(CONSOLE_PREFIX + `Tab ${newTab.id} has been auto-grouped into group ${newTab.groupId} by browser or something else`);
                return;
            }

            // when the user collapses all tab groups in a window in which there are no other tabs,
            // the browser will auto create a new ungrouped 'fallback' tab which shouldn't be added to a tab group
            isFallbackTab(newTab, (isFallback) =>
            {
                // NB: the previous `newTab` will be overwritten with the updated one

                if (isFallback)
                {
                    console.log(CONSOLE_PREFIX + "Ignoring fallback tab")
                    return;
                }

                if (lastActiveTabId)
                {
                    if (lastActiveTabId === newTab.id)
                    {
                        console.warn(CONSOLE_PREFIX + "New tab is the also the last active tab in the window.");
                        return;
                    }

                    // retrieve the last active tab in this window (before this new tab)
                    chrome.tabs.get(lastActiveTabId, (prevActiveTab) =>
                    {
                        if (chrome.runtime.lastError)
                        {
                            console.error(CONSOLE_PREFIX + "Error retrieving tab " + lastActiveTabId + ": ", chrome.runtime.lastError);
                            return;
                        }

                        if (prevActiveTab && prevActiveTab.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE)
                        {
                            console.log(CONSOLE_PREFIX + `Adding new tab (${newTab.id}) to group of last tab (${prevActiveTab.groupId})`);

                            // Add the new tab to the group of the last focused tab
                            // NOTE: this will trigger the onUpdated event and therefore run collapseOtherGroups()
                            chrome.tabs.group({ groupId: prevActiveTab.groupId, tabIds: newTab.id }, () =>
                            {
                                if (chrome.runtime.lastError)
                                {
                                    console.error(CONSOLE_PREFIX + "Error grouping new tab", chrome.runtime.lastError);
                                }
                            });
                        }
                        else
                        {
                            console.log(CONSOLE_PREFIX + "No group found for last active tab " + prevActiveTab.id);
                        }
                    });
                }
                else
                {
                    // maybe a brand new window.  just let the new tab be where it is
                    console.log(CONSOLE_PREFIX + "No last focused tab found for window " + newTab.windowId);
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
    console.log(CONSOLE_PREFIX + '>>>>>> storage.OnChanged', changes, areaName);

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
                console.log(`${CONSOLE_PREFIX}storage updating ${changedPropertyName} to`, changes[changedPropertyName].newValue);
                userOptions[changedPropertyName] = changes[changedPropertyName].newValue;
            }
            else
            {
                // an item was removed from the storage
                console.log(`${CONSOLE_PREFIX}storage removing: ${changedPropertyName}`);
                delete userOptions[changedPropertyName];
            }
        }

        console.log(CONSOLE_PREFIX + "userOptions updated:", userOptions);
    }
}


// called when the extension is about to be unloaded
function onSuspend()
{
    deregisterListeners();
    console.log(CONSOLE_PREFIX + "Listeners deregistered");
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
    console.log(CONSOLE_PREFIX + "Listeners registered");
}


function deregisterListeners()
{
    chrome.runtime.onMessage.removeListener(onRuntimeMessage);
    chrome.tabs.onActivated.removeListener(onTabActivated);
    chrome.tabs.onUpdated.removeListener(onTabUpdated);
    chrome.tabs.onCreated.removeListener(onTabCreated);
    chrome.storage.onChanged.removeListener(onStorageChanged);
    chrome.runtime.onSuspend.removeListener(onSuspend);

    console.log(CONSOLE_PREFIX + "Listeners deregistered");
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
    console.log(CONSOLE_PREFIX + ">>>>>> Browser is starting up.  Sleeping for " + LISTEN_DELAY_ON_BROWSER_STARTUP_MS + " ms before registering listeners.");
    browserStartingUp = true;
    setTimeout(registerListeners, LISTEN_DELAY_ON_BROWSER_STARTUP_MS);
});


// read userOptions
chrome.storage.sync.get(DEFAULT_OPTIONS, (options) =>
{
    userOptions = options;
    console.log(CONSOLE_PREFIX + "Options read from storage:", userOptions);
});


setTimeout(() =>
{
    if (!browserStartingUp)
    {
        console.log(CONSOLE_PREFIX + ">>>>>> Browser doesn't seem to be starting up.  Registering listeners now.");
        registerListeners();
    }
}, ON_STARTUP_WAIT_TIMEOUT_MS);


console.log(CONSOLE_PREFIX + "Extension loaded. Waiting for browser-based onStartup event for " + ON_STARTUP_WAIT_TIMEOUT_MS + " ms...");