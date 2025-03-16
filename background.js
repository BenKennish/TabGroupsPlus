// TabGroupsPlus
// background script (service worker)

// FIXME: right clicking an open tab group and clicking "Close Group" sometimes crashes browser!

import { ALIGN, DEFAULT_OPTIONS, CONSOLE_PREFIX } from './shared.js';

// timeout for receiving the browser's onStartup event
const ON_STARTUP_WAIT_TIMEOUT_MS = 500;

// time to wait before listening for events if browser is starting up
const LISTEN_DELAY_ON_BROWSER_STARTUP_MS = 10000;

// time to wait after a new tab is created before checking its group
// (the browser may move the tab into a group automatically very shortly after its creation)
const CHECK_GROUPING_DELAY_ON_CREATE_TAB_MS = 250;

// enable/disable debug console messages
const SHOW_DEBUG_CONSOLE_MSGS = true;

// user options from the storage
let userOptions = {};

// Map to store collapse/align operation timers by window id
let windowActionTimers = {};

// Map to store last focused tab id by window id
// (used when a new tab is created to then add it to the group of the previously active tab)
let lastActiveTabIds = {};

// hack to stop onActivated from stomping all over onCreated
let newlyCreatedTabs = new Set();
// won't work when new tabs are created but not switched to
// e.g. when the user middle-clicks a link to open it in a new tab
// as then the next activated tab will not trigger any group collapsing

// Map to store previous "group index" position of an active group within its window
// this index (0+) represents ordering from left-to-right considering groups only
// it's not like tab index
// e.g. activeGroupsPrevPos[42] = 2
// states that group #42 used to be in group index pos 2 (of the window that it's in)
let activeGroupsPrevPos = {};

// what we put before console log/warn/error lines to identify ourself
//const CONSOLE_PREFIX = "[TabGroupsPlus] ";

// ============================================================================
// ============================================================================
// ============================================================================



// check if our content script has been injected on the given tab
// content script cannot inject into certain content, e.g. about:blank, Google Web Store, browser settings, etc
// promise returns true if the content script responds to a ping, false otherwise
//
function isContentScriptActive(tabId)
{
    // NB: no reject needed
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
// in the order that they are displayed, excluding the group with ID 'excludeId'
//
function getTabGroupsOrdered(windowId, excludeId)
{
    return new Promise((resolve, reject) =>
    {
        // grab all the tabs in the window (will be sorted by left->right position)
        chrome.tabs.query({ windowId: windowId }, function (tabs)
        {
            if (chrome.runtime.lastError)
            {
                reject(chrome.runtime.lastError);
            }

            const groupIdsOrdered = [];

            let groupIndex = 0;
            let seenExcluded = false;

            tabs.forEach((tab) =>
            {
                if (tab.groupId === chrome.tabGroups.TAB_GROUP_ID_NONE)
                {
                    // ungrouped tab
                    return; // process next tab
                }

                if (null !== excludeId && tab.groupId == excludeId)
                {
                    // this is the 'excludeId' group, i.e. the one that contains the active tab
                    // this group may soon be moved to leftmost/rightmost position
                    // so we save the group index here
                    if (!seenExcluded)
                    {
                        console.warn(`${CONSOLE_PREFIX}Storing group ${tab.groupId} as having group index ${groupIndex}`);
                        activeGroupsPrevPos[tab.groupId] = groupIndex;
                        groupIndex++;
                        seenExcluded = true;
                    }
                    return;  // process next tab
                }

                if (!groupIdsOrdered.includes(tab.groupId))
                {
                    console.warn(`${CONSOLE_PREFIX}Storing group ${tab.groupId} into groupIdsOrdered`);
                    // if we haven't yet got this group ID, add it to list
                    groupIdsOrdered.push(tab.groupId);
                    groupIndex++;
                }

            });


            // now we need to create a list of groups in the same order as these IDs
            Promise.all(
                // creates a list of Promises that retrieve each specific tab group
                groupIdsOrdered.map(id => chrome.tabGroups.get(id))
            )
                .then((groupsOrdered) =>
                {
                    resolve(groupsOrdered)
                })
                .catch((error) =>
                {
                    reject(error);
                });
        });
    });
}


// cancel any collapse timers set for tab groups of the supplied window ID
//
function cancelCollapses(windowId)
{
    clearTimeout(windowActionTimers[windowId]);
    delete windowActionTimers[windowId];
    console.log(`${CONSOLE_PREFIX}Cleared action timer for window ${windowId}`);
}



async function getFirstTabIndexInGroup(group)
{
    try
    {
        // Query all tabs in the specified group
        const tabs = await chrome.tabs.query({ groupId: group.id });

        if (tabs.length === 0)
        {
            console.warn("No tabs found in group", group);
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
        console.error(`Error querying tabs: ${error}`);
        return null;
    }
}




// helper function for the main collapseOtherGroups() function
async function collapseAndMoveGroups(groups)
{
    for (const group of groups)
    {
        console.log(CONSOLE_PREFIX + "Preparing to collapse/move group", group);

        if (!group.collapsed)
        {
            console.log(CONSOLE_PREFIX + "Collapsing group " + group.id);
        }

        // Collapse group (wrapped as a Promise)
        await new Promise((resolve) =>
        {
            chrome.tabGroups.update(group.id, { collapsed: true }, function ()
            {
                if (chrome.runtime.lastError)
                {
                    console.error(CONSOLE_PREFIX + "Failed to collapse group " + group.id, chrome.runtime.lastError);
                }
                resolve();
            });
        });

        // If needed, move the group after collapsing
        if (userOptions.alignTabGroupsAfterCollapsing !== ALIGN.DISABLED)
        {
            let indexToMoveTo = null;

            // if this was the previously active group,
            // we want to put it back where it was
            if (activeGroupsPrevPos[group.id])
            {
                let groupPreviousIndex = activeGroupsPrevPos[group.id];

                console.log(CONSOLE_PREFIX + "Group " + group.id + " was previously active and at group index " + groupPreviousIndex);

                // fetch updated group ordering, not excluding any tab
                const groupsOrdered = await getTabGroupsOrdered(group.windowId, null);


                if (groupsOrdered[groupPreviousIndex])
                {
                    // there's a group where we want to move the
                    console.warn(CONSOLE_PREFIX + "Moving it to where this group is ", groupsOrdered[groupPreviousIndex]);
                    // fetch the index of the first tab of the group that's currently at this position
                    indexToMoveTo = await getFirstTabIndexInGroup(groupsOrdered[groupPreviousIndex]);
                }
                else
                {
                    console.error(CONSOLE_PREFIX + "No group currently at this location!")
                    indexToMoveTo = userOptions.alignTabGroupsAfterCollapsing;
                }
                delete activeGroupsPrevPos[group.id];
            }
            else
            {
                switch (userOptions.alignTabGroupsAfterCollapsing)
                {
                    case ALIGN.LEFT:
                        indexToMoveTo = 0;
                        break;
                    case ALIGN.RIGHT:
                        indexToMoveTo = -1;
                        break;
                    default:
                        console.error("Bad value for alignTabGroupsAfterCollapsing:", userOptions.alignTabGroupsAfterCollapsing);
                        continue;
                }
            }

            if (indexToMoveTo !== null)
            {
                await new Promise((resolve) =>
                {
                    chrome.tabGroups.move(group.id, { index: indexToMoveTo }, (movedGroup) =>
                    {
                        if (chrome.runtime.lastError)
                        {
                            console.error(CONSOLE_PREFIX + "Failed to move group " + group.id, chrome.runtime.lastError);
                        }
                        resolve();
                    });
                });
            }
            else
            {
                console.error(CONSOLE_PREFIX + "Didn't move group as no index decided upon");
            }
        }
    }

}



// collapses all other tab groups in the window apart from the group of the given "tab"
//
function collapseOtherGroups(tab, delayMs)
{
    // as things stand, tab is active but the other groups have not been collapsed
    // nor has this active tab's group been moved around

    if (tab.groupId === chrome.tabGroups.TAB_GROUP_ID_NONE)
    {
        if (!userOptions.collapseOthersWithGrouplessTab)
        {
            console.log(CONSOLE_PREFIX + `Tab ${tab.id}, window ${tab.windowId} is ungrouped and collapseOthersWithGrouplessTab is false. Skipping collapse of other groups.`);
            return;
        }
        console.log(CONSOLE_PREFIX + `Tab ${tab.id}, window ${tab.windowId}, group none. Collapsing all tab groups of the window...`);
    }
    else
    {
        console.log(CONSOLE_PREFIX + `Tab ${tab.id}, window ${tab.windowId}, group ${tab.groupId}. Collapsing all other tab groups of the window...`);
    }

    // clear any pending operation timers on the current tab's window
    if (windowActionTimers[tab.windowId])
    {
        clearTimeout(windowActionTimers[tab.groupId]);
        delete windowActionTimers[tab.groupId];
        console.debug(CONSOLE_PREFIX + "Cleared action timer for window", tab.windowId);
    }


    console.log(CONSOLE_PREFIX + "Retrieving ordered tab groups....");

    // fetch the IDs of the groups in this window, in left-to-right appearance order
    // excluding the given tab's group
    getTabGroupsOrdered(tab.windowId, tab.groupId).then((groupsOrdered) =>
    {
        console.log(CONSOLE_PREFIX + "Retrieved ordered tab groups", groupsOrdered);

        // when aligning them to the left, we need to process tab groups in reverse (right-to-left order)
        if (userOptions.alignTabGroupsAfterCollapsing == ALIGN.LEFT)
        {
            // so reverse the group ordering
            groupsOrdered.reverse();
        }

        // cancel an old action timer if one is already scheduled
        if (windowActionTimers[tab.windowId])
        {
            clearTimeout(windowActionTimers[tab.windowId]);
            delete windowActionTimers[tab.windowId];
            console.log(CONSOLE_PREFIX + "Cleared leftover window action timer for window: " + tab.windowId);
        }

        console.log(CONSOLE_PREFIX + `Scheduling action timer for window ${tab.windowId} in ${delayMs} ms...`);

        windowActionTimers[tab.windowId] = setTimeout(async function ()
        {
            console.log("Action timer for window " + tab.windowId + " running");
            console.log("groupsOrdered", groupsOrdered);

            await collapseAndMoveGroups(groupsOrdered);

            // delete the timer as it's now finished running
            delete windowActionTimers[tab.windowId];

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

// register our listeners
//
function registerListeners()
{
    // Listen for messages from content scripts
    //
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) =>
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
                    console.warn(CONSOLE_PREFIX + 'Mouse entered/left content area of non-active tab!', contentTab);
                }
                else if (isMouseInContentArea)
                {
                    console.debug(CONSOLE_PREFIX + 'Mouse entered contentTab', contentTab);
                    collapseOtherGroups(contentTab, userOptions.collapseDelayOnEnterContentAreaMs);
                }
                else  // IsMouseInContentArea is false
                {
                    console.debug(CONSOLE_PREFIX + 'Mouse left contentTab', contentTab);

                    // we cancel all the collapse operations in case they went back up to the tab list
                    cancelCollapses(contentTab.windowId);
                }
                sendResponse({ status: "ok" });
                break;

            default:
                console.error(CONSOLE_PREFIX + "Unexpected action from content script: '" + message.action + "'")
                sendResponse({ status: "invalidAction" });

        }

    });

    // Listen for tab activation to schedule collapse of non-active groups
    // fallback if the content script cannot be injected into the tab contents
    //
    chrome.tabs.onActivated.addListener((activeInfo) =>
    {
        lastActiveTabIds[activeInfo.windowId] = activeInfo.tabId;

        console.debug(CONSOLE_PREFIX + "onActivated updated lastActiveTabIds with tab id: ", activeInfo.tabId);

        isContentScriptActive(activeInfo.tabId).then((isInjected) =>
        {
            if (isInjected)
            {
                console.log(`${CONSOLE_PREFIX}Activated tab ${activeInfo.tabId} already has content script injected`);
                return;
            }

            // try to dynamically inject content script
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

                    // instead we just collapse other groups after a timeout
                    chrome.tabs.get(activeInfo.tabId, (activeTab) =>
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
                        collapseOtherGroups(activeTab, userOptions.collapseDelayOnActivateUninjectedTabMs);
                    });
                }
                else
                {
                    console.log(CONSOLE_PREFIX + "Content script injected into activated tab", activeInfo.tabId);
                }
            });
        });
    });


    // Listen for when a tab is updated, in particular when moved into a new group
    // fallback if the content script cannot be injected into the tab contents
    //
    chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) =>
    {
        // tab's group assignment was changed
        if (changeInfo.hasOwnProperty('groupId'))
        {
            isContentScriptActive(tabId).then((isInjected) =>
            {
                if (isInjected)
                {
                    console.log(`${CONSOLE_PREFIX}Injected tab ${tabId} moved to group ${changeInfo.groupId} - ignoring`)
                    // we don't need to take any action on update of a tab with the content script injected
                    // because the content script will collapse the tab groups on mouse entering the content area
                    return;
                }

                // non-injected tab..
                //
                // if the tab wasn't made groupless
                if (changeInfo.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE)
                {
                    console.log(CONSOLE_PREFIX + `>>> Uninjected tab ${tabId} moved to group ${changeInfo.groupId}`);

                    // fetch tab object
                    chrome.tabs.get(tabId, function (tab)
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
                            collapseOtherGroups(tab, userOptions.collapseDelayOnActivateUninjectedTabMs);
                        }
                        else
                        {
                            console.log(CONSOLE_PREFIX + "Regrouped tab is not the active tab.  Ignoring.");
                        }
                    });
                }
            });

        };
    });


    // Listen for new tab creation to add it to the active group if applicable
    //
    // note: if the user wants to create a new ungrouped tab on a window with only tab groups,
    // they can create the tab and then drag it outside the tab groups
    //
    chrome.tabs.onCreated.addListener(function (newTab)
    {
        // we immediately grab this before onActivated runs for this tab and updates it with this tab ID
        let lastActiveTabId = lastActiveTabIds[newTab.windowId];

        if (!userOptions.autoGroupNewTabs)
        {
            return;
        }

        console.log(CONSOLE_PREFIX + `>>> Tab created: ${newTab.id} in window ${newTab.windowId}`);

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
            console.log(CONSOLE_PREFIX + "New tab is already in a group.");
            return;
        }

        setTimeout(() =>
        {
            // refetch the tab to check for updates
            chrome.tabs.get(newTab.id, function (newTab)
            {
                // NOTE: newTab now refers to the newly fetched tab object, not the one received by the listener

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
                isFallbackTab(newTab, function (isFallback)
                {
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
                        chrome.tabs.get(lastActiveTabId, function (prevActiveTab)
                        {
                            if (chrome.runtime.lastError)
                            {
                                console.error(CONSOLE_PREFIX + "Error retrieving tab: ", chrome.runtime.lastError);
                                return;
                            }

                            if (prevActiveTab && prevActiveTab.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE)
                            {
                                console.log(CONSOLE_PREFIX + `Adding new tab (${newTab.id}) to group of last tab (${prevActiveTab.groupId})`);

                                // Add the new tab to the group of the last focused tab
                                // NOTE: this will trigger the onUpdated event and therefore run collapseOtherGroups()
                                chrome.tabs.group({ groupId: prevActiveTab.groupId, tabIds: newTab.id }, function ()
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

    });


    // listen for when the options page was used to save new options in the storage
    // we need to update the userOptions object to match
    //
    chrome.storage.onChanged.addListener(function (changes, areaName)
    {
        console.log(CONSOLE_PREFIX + 'storage.OnChanged', changes, areaName);

        if (areaName === 'sync')
        {
            // example:
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

            console.log(CONSOLE_PREFIX + "userOptions now looks like this", userOptions);
        }
    });


    browserStartingUp = false;
    console.log(CONSOLE_PREFIX + "Listeners registered");
}



// Stop console.debug() working if we're not debugging
if (!SHOW_DEBUG_CONSOLE_MSGS)
{
    console.debug = function () { };
}

let browserStartingUp = false;

// Workaround: delay starting extension logic for short while so as to avoid messing while
// the browser restores windows, tabs, and groups from a previous session
chrome.runtime.onStartup.addListener(() =>
{
    // Initialization code for startup scenarios
    console.log(CONSOLE_PREFIX + "Browser is starting up.  Sleeping for " + LISTEN_DELAY_ON_BROWSER_STARTUP_MS + " ms before registering listeners.");
    browserStartingUp = true;
    setTimeout(registerListeners, LISTEN_DELAY_ON_BROWSER_STARTUP_MS);
});


chrome.storage.sync.get(DEFAULT_OPTIONS, (options) =>
{
    // Use items.option1 and items.option2 as your configuration values
    userOptions = options;
    console.log(CONSOLE_PREFIX + "Options read from storage:", userOptions);
});


setTimeout(() =>
{
    if (!browserStartingUp)
    {
        console.log(CONSOLE_PREFIX + "Browser is NOT starting up.  Registering listeners now.");
        registerListeners();
    }
}, ON_STARTUP_WAIT_TIMEOUT_MS);

console.log(CONSOLE_PREFIX + "Extension loaded. Waiting for browser-based onStartup event for " + ON_STARTUP_WAIT_TIMEOUT_MS + " ms...");