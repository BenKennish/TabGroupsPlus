// TabGroupsPlus
// background.js
//
// FIXME: the content script cannot access certain tab contents, e.g. about:blank, Google Web Store, etc

// Debug logging helper
function log(msg, data)
{
    if (data !== undefined)
    {
        console.log(`[TabGroupsPlus] ${msg}`, data);
    }
    else
    {
        console.log(`[TabGroupsPlus] ${msg}`);
    }
}

function warn(msg, data)
{
    if (data !== undefined)
    {
        console.warn(`[TabGroupsPlus] ${msg}`, data);
    }
    else
    {
        console.warn(`[TabGroupsPlus] ${msg}`);
    }
}

function error(msg, data)
{
    if (data !== undefined)
    {
        console.error(`[TabGroupsPlus] ${msg}`, data);
    }
    else
    {
        console.error(`[TabGroupsPlus] ${msg}`);
    }
}

// timeout for receiving the browser's onStartup event
const onStartupWaitTimeoutMs = 3000;

// time to wait if browser is starting up, before listening for events
const listenDelayOnBrowserStartupMs = 10000;

// time to wait after mouse entering a tab's content area
// before collapsing the other tab groups in the window
const collapseDelayOnEnterContentAreaMs = 1000;

// time to wait after activating a tab without a content script
// before collapsing the other tab groups in the window
const collapseDelayOnActivateUninjectedTabMs = 3000;

// Map to store collapse timers keyed by group id
let collapseTimers = {};

// Map to store last focused tab id by window id
// (used when a new tab is created to add it to the group of the last focused tab)
let lastFocusedTabIds = {};

// hack to stop onActivated from stomping all over onCreated
let newlyCreatedTabs = new Set();
// won't work when new tabs are created but not switched to
// e.g. when the user middle-clicks a link to open it in a new tab
// as then the next activated tab will not trigger any group collapsing


// check if our content script is running on the given tab
// content script cannot inject into certain content, e.g. about:blank, Google Web Store, browser settings, etc
// returns true if the content script is active, false otherwise
function isContentScriptActive(tabId)
{
    chrome.tabs.sendMessage(tabId, { action: "ping" }, (response) =>
    {
        if (chrome.runtime.lastError)
        {
            log("Content script not available in tab:", tabId);
            return false;
        }
        else
        {
            return true;
        }
    });
}


// collapses all other tab groups in the window apart from the group of the active tab
function collapseOtherGroups(activeTab, delayMs)
{

    lastFocusedTabIds[activeTab.windowId] = activeTab.id;

    if (activeTab.groupId === chrome.tabGroups.TAB_GROUP_ID_NONE)
    {
        log(`Active tab ${activeTab.id}, window ${activeTab.windowId} is ungrouped. Skipping collapse.`);
        return;
    }

    log(`Active tab ${activeTab.id}, window ${activeTab.windowId}, group ${activeTab.groupId}`);

    chrome.tabGroups.get(activeTab.groupId, function (activeGroup)
    {
        if (chrome.runtime.lastError)
        {
            error("Failed to query active group " + activeTab.groupId, chrome.runtime.lastError);
            return;
        }

        if (!activeGroup)
        {
            error("Couldn't retrieve active group" + activeTab.groupId, activeGroup);
            return;
        }

        log("Active tab's group", activeGroup);

        if (activeGroup.collapsed)
        {
            warn("Group of the active tab is collapsed.  Bit weird.");
            return;
        }

        // foreach tab group in this window
        chrome.tabGroups.query({ windowId: activeTab.windowId }, function (groups)
        {
            if (chrome.runtime.lastError)
            {
                error("Failed to query all groups for window " + activeTab.windowId, chrome.runtime.lastError);
                return;
            }

            // look for expanded tab groups in the current window
            groups.forEach(function (group)
            {
                // Don't collapse the active group or already collapsed groups
                if (group.id !== activeTab.groupId && !group.collapsed)
                {
                    // cancel a collapse operations if already scheduled
                    if (collapseTimers[group.id])
                    {
                        clearTimeout(collapseTimers[group.id]);
                    }

                    log(`Scheduling collapse for group ${group.id} in ${delayMs} ms...`);

                    collapseTimers[group.id] = setTimeout(function ()
                    {
                        log("Collapsing group " + group.id);
                        chrome.tabGroups.update(group.id, { collapsed: true }, function ()
                        {
                            if (chrome.runtime.lastError)
                            {
                                // FIXME: this can happen if user is currently interacting with tabs,
                                // e.g. dragging one around.  maybe we should we keep retrying?
                                error("Failed to collapse group " + group.id, chrome.runtime.lastError);
                            }
                        });
                        delete collapseTimers[group.id];
                    }, delayMs);
                }
                else
                {
                    // cancel any collapse operations that are already scheduled for the active group
                    // or collapsed groups

                    if (collapseTimers[group.id])
                    {
                        clearTimeout(collapseTimers[group.id]);
                        delete collapseTimers[group.id];
                        log("Cleared collapse timer for active group " + group.id);
                    }
                }
            });
        });
    });

}



// test to see if a new tab is (likely to be) a 'fallback' tab: a tab that was automatically created because the user
// collapsed all tab groups in the window and there were no ungrouped tabs
function isFallbackTab(win, newTab, callback)
{
    // Assume `win` is a window object with a populated `tabs` array,
    // and `newTab` is the newly created tab object.
    // callback(true) if the window consists only of this tab (ungrouped) and 0 or more collapsed tab groups

    let otherTabs = win.tabs.filter(tab => tab.id !== newTab.id);

    if (otherTabs.length === 0)
    {
        // window contains only the new tab
        callback(true);
        return;
    }
    else
    {
        // Separate tabs that are not in any group (groupId === -1)
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
                        error(`Group ${gid} not found.`);
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
}


function registerListeners()
{

    // Listen for messages from content scripts
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) =>
    {
        if (message.action === 'mouseInContentArea')
        {
            let isMouseInContentArea = message.value;

            if (isMouseInContentArea)
            {
                let contentTab = sender.tab;
                log('Mouse entered contentTab', contentTab);

                if (contentTab)
                {
                    collapseOtherGroups(contentTab, collapseDelayOnEnterContentAreaMs);
                }
                else
                {
                    warn('No sender tab for mouseInContentArea event');
                }
            }
        }

    });

    // Listen for tab activation to schedule collapse of non-active groups
    // fallback if the content script cannot be injected into the tab contents
    chrome.tabs.onActivated.addListener(function (activeInfo)
    {
        if (isContentScriptActive(activeInfo.tabId))
        {
            return;
        }

        // user has activated a tab that the content script isn't injected into
        log(">>> Uninjected tab activated: " + activeInfo.tabId);

        chrome.tabs.get(activeInfo.tabId, function (activeTab)
        {
            if (chrome.runtime.lastError)
            {
                error("Failed to get activated tab " + activeInfo.tabId, chrome.runtime.lastError);
                return;
            }

            if (newlyCreatedTabs.has(activeTab.id))
            {
                log("Ignoring first activation of newly created tab " + activeTab.id)
                newlyCreatedTabs.delete(activeTab.id);
                return;
            }
            collapseOtherGroups(activeTab, collapseDelayOnActivateUninjectedTabMs);
        });

    });


    // Listen for when a tab is updated, in particular when moved into a new group
    // fallback if the content script cannot be injected into the tab contents
    chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) =>
    {
        if (isContentScriptActive(tabId))
        {
            return;
        }

        log(">>> Uninjected tab updated: " + tabId);

        // Check if the groupId property was updated
        if (changeInfo.hasOwnProperty('groupId'))
        {
            // A change occurred in the tab's group assignment.
            if (changeInfo.groupId !== -1)
            {
                log(`>>> Tab ${tabId} was moved to group ${changeInfo.groupId}`);

                // if a tab is moved from an expanded group into a collapsed group,
                // the group will stay collapsed and a different tab may be activated

                // FIXME: the tab that was updated might not be the active tab!
                chrome.tabs.get(tabId, function (activeTab)
                {
                    if (chrome.runtime.lastError)
                    {
                        error("Failed to get activated tab " + tabId, chrome.runtime.lastError);
                        return;
                    }
                    collapseOtherGroups(activeTab, collapseDelayOnActivateUninjectedTabMs);
                });
            }
        }

    });


    // Listen for new tab creation to add it to the active group if applicable
    //
    // note: if the user wants to create a new ungrouped tab on a window with only tab groups,
    // they can create the tab and then drag it outside the tab groups
    chrome.tabs.onCreated.addListener(function (newTab)
    {
        log(`>>> Tab created: ${newTab.id} in window ${newTab.windowId}`);

        if (!isContentScriptActive(activeInfo.tabId))
        {
            newlyCreatedTabs.add(newTab.id);
        }

        if (newTab.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE)
        {
            log("New tab is already in a group.");
            return;
        }

        chrome.windows.get(newTab.windowId, { populate: true }, function (win)
        {
            if (chrome.runtime.lastError)
            {
                error("Error getting window for new tab", chrome.runtime.lastError);
                return;
            }

            // when the user collapses all tab groups in a window in which there are no other tabs,
            // the browser will auto create a new ungrouped 'fallback' tab which shouldn't be added to a tab group
            isFallbackTab(win, newTab, function (isFallback)
            {
                if (isFallback)
                {
                    log("Ignoring fallback tab")
                    return;
                }

                if (lastFocusedTabIds[newTab.windowId])
                {
                    // retrieve the last focused tab in this window (before this new tab)
                    chrome.tabs.get(lastFocusedTabIds[newTab.windowId], function (lastFocusedTab)
                    {
                        if (chrome.runtime.lastError)
                        {
                            error("Error retrieving tab: ", chrome.runtime.lastError);
                            return;
                        }

                        if (lastFocusedTab && lastFocusedTab.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE)
                        {
                            log(`Adding new tab (${newTab.id}) to group of last tab (${lastFocusedTab.groupId})`);

                            // Add the new tab to the group of the last focused tab
                            // NOTE: this will trigger the onUpdated event and therefore run collapseOtherGroups()
                            chrome.tabs.group({ groupId: lastFocusedTab.groupId, tabIds: newTab.id }, function ()
                            {
                                if (chrome.runtime.lastError)
                                {
                                    error("Error grouping new tab", chrome.runtime.lastError);
                                }
                            });
                        }
                        else
                        {
                            log("No active group found for last focused tab " + lastFocusedTab.id);
                        }
                    });
                }
                else
                {
                    // maybe a brand new window.  just let the new tab be where it is
                    log("No last focused tab found for window " + newTab.windowId);
                }

            });

        });

    });

    browserStartingUp = false;
    log("Listeners registered");
}


// inject content scripts into all tabs
// means that if we enable or reload the extension, we don't have to reload all the tabs
// **UNFINISHED**
//
// chrome.runtime.onInstalled.addListener(() =>
// {
//     // Query all tabs matching http/https URLs
//     chrome.tabs.query({ url: ["http://*/*", "https://*/*"] }, function (tabs)
//     {
//         for (let tab of tabs)
//         {
//             chrome.scripting.executeScript({
//                 target: { tabId: tab.id },
//                 files: ['content.js']
//             });
//         }
//     });
// });


let browserStartingUp = false;

// Workaround: delay starting extension logic for short while so as to avoid messing while
// the browser restores windows, tabs, and groups from a previous session
chrome.runtime.onStartup.addListener(() =>
{
    // Initialization code for startup scenarios
    log("Browser is starting up.  Sleeping for " + listenDelayOnBrowserStartupMs + " ms before registering listeners.");
    browserStartingUp = true;
    setTimeout(registerListeners, listenDelayOnBrowserStartupMs);
});


setTimeout(() =>
{
    if (!browserStartingUp)
    {
        log("Browser is NOT starting up.  Registering listeners now.");
        registerListeners();
    }
}, onStartupWaitTimeoutMs);

log("Extension loaded. Waiting for browser-based onStartup event for " + onStartupWaitTimeoutMs + " ms...");