// TabGroupsPlus
// background.js
//
// the content script cannot access certain tab contents, e.g. about:blank, Google Web Store, etc

// FIXME: opening a closed (not collapsed, closed) group, e.g. from Bookmarks bar, seems
// to open the tabs within the current tab

// FIXME: right clicking an open tab group and clicking "Close Group" crashes browser!

// timeout for receiving the browser's onStartup event
const onStartupWaitTimeoutMs = 500;

// time to wait before listening for events if browser is starting up
const listenDelayOnBrowserStartupMs = 10000;

// time to wait after mouse cursor entering a tab's content area
// before collapsing the other tab groups in the window
const collapseDelayOnEnterContentAreaMs = 750;

// time to wait after activating a tab without our content script injected
// before collapsing the other tab groups in the window
const collapseDelayOnActivateUninjectedTabMs = 4000;

// time to wait after a new tab is created before checking its group
// (because the browser may move the tab into a group automatically)
const checkGroupingDelayOnCreateTabMs = 100;

// enable/disable debug console messages
const showDebugConsoleMsgs = true;

// Map to store collapse timers keyed by group id
let collapseTimers = {};

// Map to store last focused tab id by window id
// (used when a new tab is created to then add it to the group of the previously focused tab)
let lastActiveTabIds = {};

// hack to stop onActivated from stomping all over onCreated
let newlyCreatedTabs = new Set();
// won't work when new tabs are created but not switched to
// e.g. when the user middle-clicks a link to open it in a new tab
// as then the next activated tab will not trigger any group collapsing

// Console logging helpers

if (!showDebugConsoleMsgs)
{
    console.debug = function () { };
}

// what we put before log lines to identify ourself
const consolePrefix = "[TabGroupsPlus] ";

// check if our content script has been injected on the given tab
// content script cannot inject into certain content, e.g. about:blank, Google Web Store, browser settings, etc
// promise returns true if the content script responds to a ping, false otherwise
//
// maybe this could be done better with an async function using await ?
function isContentScriptActive(tabId)
{
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


// collapses all other tab groups in the window apart from the group of the supplied tab
function collapseOtherGroups(tab, delayMs)
{
    //lastActiveTabIds[tab.windowId] = tab.id;

    if (tab.groupId === chrome.tabGroups.TAB_GROUP_ID_NONE)
    {
        console.log(consolePrefix + `Tab ${tab.id}, window ${tab.windowId} is ungrouped. Skipping collapse of other groups.`);
        return;
    }

    console.debug(consolePrefix + `Tab ${tab.id}, window ${tab.windowId}, group ${tab.groupId} : looking for other groups to collapse...`);


    // fetch group of the tab
    chrome.tabGroups.get(tab.groupId, function (group)
    {
        if (chrome.runtime.lastError)
        {
            console.error(consolePrefix + "Failed to query group " + tab.groupId, chrome.runtime.lastError);
            return;
        }

        if (!group)
        {
            console.error(consolePrefix + "Failed to retrieve tab's group" + tab.groupId, group);
            return;
        }

        if (group.collapsed)
        {
            console.warn(consolePrefix + "Group of the tab is collapsed.  Bit unexpected.  Bailing out");
            return;
        }

        // examine each tab group in this window
        chrome.tabGroups.query({ windowId: tab.windowId }, function (groups)
        {
            if (chrome.runtime.lastError)
            {
                console.error(consolePrefix + "Failed to query all groups for window " + tab.windowId, chrome.runtime.lastError);
                return;
            }

            let numCollapsedGroups = 0;

            // look for expanded tab groups in the current window
            groups.forEach(function (g)
            {
                // Don't collapse the active group or already collapsed groups
                if (g.id !== tab.groupId && !g.collapsed)
                {
                    // cancel an old collapse operation if already scheduled
                    if (collapseTimers[g.id])
                    {
                        clearTimeout(collapseTimers[g.id]);
                    }

                    console.log(consolePrefix + `Scheduling collapse for group ${g.id} in ${delayMs} ms...`);
                    numCollapsedGroups++;

                    collapseTimers[g.id] = setTimeout(function ()
                    {
                        console.log(consolePrefix + "Collapsing group " + g.id);
                        chrome.tabGroups.update(g.id, { collapsed: true }, function ()
                        {
                            if (chrome.runtime.lastError)
                            {
                                // FIXME: fails if user is currently interacting with tabs,
                                // e.g. dragging one around.  maybe we should we keep retrying?
                                console.error(consolePrefix + "Failed to collapse group " + g.id, chrome.runtime.lastError);
                            }
                        });
                        delete collapseTimers[g.id];
                    }, delayMs);
                }
                else
                {
                    // this is the tab's group or an already collapsed group
                    // cancel any collapse operations that are already scheduled

                    if (collapseTimers[g.id])
                    {
                        clearTimeout(collapseTimers[g.id]);
                        delete collapseTimers[g.id];
                        console.debug(consolePrefix + "Cleared collapse timer for active/collapsed group: " + group.id);
                    }
                }
            });

            console.log(consolePrefix + "Groups scheduled for collapse:", numCollapsedGroups);
        });
    });

}



// test to see if a new tab is (likely to be) a 'fallback' tab: a tab that was automatically created because the user
// collapsed all tab groups in the window and there were no ungrouped tabs
//
function isFallbackTab(newTab, callback)
{
    // `newTab` is the tab object to examine (probably a newly created tab).
    // callback is sent true if the window consists only of this tab (ungrouped) and 0 or more collapsed tab groups

    if (!newTab)
    {
        console.error(consolePrefix + "No new tab provided to isFallbackTab");
        callback(false);
    }

    chrome.windows.get(newTab.windowId, { populate: true }, (win) =>
    {
        if (chrome.runtime.lastError)
        {
            console.error(consolePrefix + "Error retrieving window for tab :", chrome.runtime.lastError);
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
                            console.error(consolePrefix + `Group ${gid} not found.`);
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
                console.debug(consolePrefix + 'Mouse entered contentTab', contentTab);

                // assuming we can't enter the content area of a tab that isn't the active tab...
                if (contentTab)
                {
                    if (contentTab.active)
                    {
                        collapseOtherGroups(contentTab, collapseDelayOnEnterContentAreaMs);
                    }
                    else
                    {
                        console.warn(consolePrefix + 'Mouse entered content area of non-active tab!', contentTab);
                    }
                }
                else
                {
                    console.warn(consolePrefix + 'No sender tab for mouseInContentArea event');
                }
            }
            sendResponse({ status: "ok" });
        }
        else
        {
            sendResponse({ status: "invalidAction" });
        }

    });

    // Listen for tab activation to schedule collapse of non-active groups
    // fallback if the content script cannot be injected into the tab contents
    chrome.tabs.onActivated.addListener((activeInfo) =>
    {
        // is this getting run for new tabs before onCreated examines it?
        lastActiveTabIds[activeInfo.windowId] = activeInfo.tabId;
        console.debug(consolePrefix + "onActivated updated lastActiveTabIds with tab id: ", activeInfo.tabId);

        isContentScriptActive(activeInfo.tabId).then((isInjected) =>
        {
            if (isInjected)
            {
                console.log(consolePrefix + `Activated tab ${activeInfo.tabId} already has content script injected`);
                return;
            }

            // try to dynamically inject content script
            chrome.scripting.executeScript({ target: { tabId: activeInfo.tabId }, files: ["content.js"] }, () =>
            {
                if (chrome.runtime.lastError)
                {
                    // this tab doesn't support content scripting (e.g. about:blank, Google Web Store, browser settings, etc)
                    console.warn(consolePrefix + "Error injecting content script into tab " + activeInfo.tabId + ": ", chrome.runtime.lastError.message);

                    // instead we just collapse other groups after a timeout
                    chrome.tabs.get(activeInfo.tabId, (activeTab) =>
                    {
                        if (chrome.runtime.lastError)
                        {
                            console.error(consolePrefix + "Failed to get activated tab " + activeInfo.tabId, chrome.runtime.lastError);
                            return;
                        }

                        if (newlyCreatedTabs.has(activeTab.id))
                        {
                            console.log(consolePrefix + "Ignoring first activation of newly created tab", activeTab.id)
                            newlyCreatedTabs.delete(activeTab.id);
                            return;
                        }
                        collapseOtherGroups(activeTab, collapseDelayOnActivateUninjectedTabMs);
                    });
                }
                else
                {
                    console.log(consolePrefix + "Content script injected into activated tab", activeInfo.tabId);
                }
            });
        });

    });


    // Listen for when a tab is updated, in particular when moved into a new group
    // fallback if the content script cannot be injected into the tab contents
    chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) =>
    {
        isContentScriptActive(tabId).then((isInjected) =>
        {
            if (isInjected)
            {
                // we don't need to take any action on update of a tab with the content script injected
                // because the content script will collapse the tab groups on mouse entering the content area
                return;
            }

            // tab's group assignment was changed
            if (changeInfo.hasOwnProperty('groupId'))
            {
                // if the tab wasn't made groupless
                if (changeInfo.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE)
                {
                    console.log(consolePrefix + `>>> Uninjected tab ${tabId} moved to group ${changeInfo.groupId}`);

                    // if the active tab is moved from an expanded group into a collapsed group, the new group will expand
                    // if the tab isn't the active tab, the new group will stay collapsed

                    chrome.tabs.get(tabId, function (tab)
                    {
                        if (chrome.runtime.lastError)
                        {
                            console.error(consolePrefix + "Failed to get updated tab " + tabId, chrome.runtime.lastError);
                            return;
                        }

                        if (tab.active)
                        {
                            collapseOtherGroups(tab, collapseDelayOnActivateUninjectedTabMs);
                        }
                        else
                        {
                            console.log(consolePrefix + "Updated tab is not the active tab.  Ignoring.");
                        }
                    });
                }
            }
        });
    });


    // Listen for new tab creation to add it to the active group if applicable
    //
    // note: if the user wants to create a new ungrouped tab on a window with only tab groups,
    // they can create the tab and then drag it outside the tab groups

    chrome.tabs.onCreated.addListener(function (newTab)
    {
        // we immediately grab this before onActivated runs for this tab and updates it with this tab ID
        let lastActiveTabId = lastActiveTabIds[newTab.windowId];

        console.log(consolePrefix + `>>> Tab created: ${newTab.id} in window ${newTab.windowId}`);

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
            console.log(consolePrefix + "New tab is already in a group.");
            return;
        }

        setTimeout(() =>
        {
            // refetch the tab to check for updates
            chrome.tabs.get(newTab.id, function (newTab)
            {
                if (chrome.runtime.lastError)
                {
                    console.error(consolePrefix + "Error 're-getting' tab:", chrome.runtime.lastError);
                    return;
                }

                // If tab has NOW been assigned a group, skip grouping
                if (newTab.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE)
                {
                    console.log(consolePrefix + `Tab ${newTab.id} has been auto-grouped into group ${newTab.groupId} by browser or something else`);
                    return;
                }


                // when the user collapses all tab groups in a window in which there are no other tabs,
                // the browser will auto create a new ungrouped 'fallback' tab which shouldn't be added to a tab group
                isFallbackTab(newTab, function (isFallback)
                {
                    if (isFallback)
                    {
                        console.log(consolePrefix + "Ignoring fallback tab")
                        return;
                    }

                    if (lastActiveTabId)
                    {
                        if (lastActiveTabId === newTab.id)
                        {
                            console.warn(consolePrefix + "New tab is the also the last active tab in the window.");
                            return;
                        }

                        // retrieve the last active tab in this window (before this new tab)
                        chrome.tabs.get(lastActiveTabId, function (prevActiveTab)
                        {
                            if (chrome.runtime.lastError)
                            {
                                console.error(consolePrefix + "Error retrieving tab: ", chrome.runtime.lastError);
                                return;
                            }

                            if (prevActiveTab && prevActiveTab.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE)
                            {
                                console.log(consolePrefix + `Adding new tab (${newTab.id}) to group of last tab (${prevActiveTab.groupId})`);

                                // Add the new tab to the group of the last focused tab
                                // NOTE: this will trigger the onUpdated event and therefore run collapseOtherGroups()
                                chrome.tabs.group({ groupId: prevActiveTab.groupId, tabIds: newTab.id }, function ()
                                {
                                    if (chrome.runtime.lastError)
                                    {
                                        console.error(consolePrefix + "Error grouping new tab", chrome.runtime.lastError);
                                    }
                                });
                            }
                            else
                            {
                                console.log(consolePrefix + "No group found for last active tab " + prevActiveTab.id);
                            }
                        });
                    }
                    else
                    {
                        // maybe a brand new window.  just let the new tab be where it is
                        console.log(consolePrefix + "No last focused tab found for window " + newTab.windowId);
                    }

                });

            });

        }, checkGroupingDelayOnCreateTabMs); // we pause to give the browser time to potentially move the tab into a new group if applicable

    });

    browserStartingUp = false;
    console.log(consolePrefix + "Listeners registered");
}


let browserStartingUp = false;

// Workaround: delay starting extension logic for short while so as to avoid messing while
// the browser restores windows, tabs, and groups from a previous session
chrome.runtime.onStartup.addListener(() =>
{
    // Initialization code for startup scenarios
    console.log(consolePrefix + "Browser is starting up.  Sleeping for " + listenDelayOnBrowserStartupMs + " ms before registering listeners.");
    browserStartingUp = true;
    setTimeout(registerListeners, listenDelayOnBrowserStartupMs);
});


setTimeout(() =>
{
    if (!browserStartingUp)
    {
        console.log(consolePrefix + "Browser is NOT starting up.  Registering listeners now.");
        registerListeners();
    }
}, onStartupWaitTimeoutMs);

console.log(consolePrefix + "Extension loaded. Waiting for browser-based onStartup event for " + onStartupWaitTimeoutMs + " ms...");