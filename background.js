// Debug logging helper
function log(msg, data)
{
    if (data !== undefined)
    {
        console.log(`[TabGroupTidier] ${msg}`, data);
    }
    else
    {
        console.log(`[TabGroupTidier] ${msg}`);
    }
}

function warn(msg, data)
{
    if (data !== undefined)
    {
        console.warn(`[TabGroupTidier] ${msg}`, data);
    }
    else
    {
        console.warn(`[TabGroupTidier] ${msg}`);
    }
}

function error(msg, data)
{
    if (data !== undefined)
    {
        console.error(`[TabGroupTidier] ${msg}`, data);
    }
    else
    {
        console.error(`[TabGroupTidier] ${msg}`);
    }
}



// time to wait after activating a tab before collapsing the other tab groups in the window
let waitToCollapseMs = 3000;

// Map to store collapse timers keyed by group id
let collapseTimers = {};

// Map to store last focused tab id by window id
// (used when they create a new tab
let lastFocusedTabIds = {};

// BADHACK - to stop onActivated from stomping all over onCreated
//
// won't work when new tabs are created but not switched to
// e.g. when the user middle-clicks a link to open it in a new tab
// as then the next activated tab will not trigger any group collapsing
let isNewTab = false;


function collapseOtherGroups(activeTab)
{
    if (isNewTab)
    {
        log("Ignoring newly created tab " + activeTab.id)
        isNewTab = false;
        return;
    }

    lastFocusedTabIds[activeTab.windowId] = activeTab.id;

    if (activeTab.groupId === -1)
    {
        log(`Active tab ${activeTab.id}, window ${activeTab.windowId} is ungrouped. Skipping collapse.`);
        return;
    }

    log(`Active tab ${activeTab.id}, window ${activeTab.windowId}, group ${activeTab.groupId}`);

    // Clear collapse timers for all groups in this window.
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

                log(`Scheduling collapse for group ${group.id} in ${waitToCollapseMs} ms.`);

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
                }, waitToCollapseMs);
            }
            else
            {
                // cancel any collapse operations that are already scheduled for the active group
                if (collapseTimers[group.id])
                {
                    clearTimeout(collapseTimers[group.id]);
                    delete collapseTimers[group.id];
                    log("Cleared collapse timer for active group " + group.id);
                }
            }
        });
    });
}


// Listen for tab activation to schedule collapse of non-active groups
chrome.tabs.onActivated.addListener(function (activeInfo)
{
    //log("Tab activated: " + activeInfo.tabId)

    chrome.tabs.get(activeInfo.tabId, function (activeTab)
    {
        if (chrome.runtime.lastError)
        {
            error("Failed to get activated tab " + activeInfo.tabId, chrome.runtime.lastError);
            return;
        }
        collapseOtherGroups(activeTab);
    });
});


// Watch for when a tab is moved into a new group
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) =>
{
    // Check if the groupId property was updated
    if (changeInfo.hasOwnProperty('groupId'))
    {
        // A change occurred in the tab's group assignment.
        if (changeInfo.groupId !== -1)
        {
            log(`Tab ${tabId} was moved to group ${changeInfo.groupId}`);

            // if a tab is moved from an expanded group into a collapsed group,
            // the group will stay collapsed and a different tab may be activated

            chrome.tabs.get(tabId, function (activeTab)
            {
                if (chrome.runtime.lastError)
                {
                    error("Failed to get activated tab " + tabId, chrome.runtime.lastError);
                    return;
                }

                // TODO: maybe check to see if the group that this tab has been moved into is in an expanded state
                collapseOtherGroups(activeTab);
            });
        }
    }
});


// tests to see if a new tab is a 'fallback' tab: a tab that was automatically created because the user collapsed all
// tab groups in the window and there were no ungrouped tabs
function isFallbackTab(win, newTab, callback)
{
    // Assume `win` is a window object with a populated `tabs` array,
    // and `newTab` is the newly created tab object.
    // return true if the window consists only of this tab (ungrouped) and 0 or more collapsed tab groups

    let otherTabs = win.tabs.filter(tab => tab.id !== newTab.id);

    if (otherTabs.length === 0)
    {
        log("The window contains only the new tab.");
        callback(true);
        return;
    }
    else
    {
        // Separate tabs that are not in any group (groupId === -1)
        let nonGroupedTabs = otherTabs.filter(tab => tab.groupId === -1);

        if (nonGroupedTabs.length > 0)
        {
            log("Some (other) tabs are not in any tab group.", nonGroupedTabs);
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
                        //log(`Group ${gid} is not collapsed.`);
                        allCollapsed = false;
                        break;
                    }
                }

                if (allCollapsed)
                {
                    log("The window contains only collapsed tab groups and the new tab.");
                    callback(true);
                }
                else
                {
                    log("Not all tab groups are collapsed.");
                    callback(false);
                }
            });
        }
    }
}


// Listen for new tab creation to add it to the active group if applicable
// if the user wants to create a new ungrouped tab on a window with only tab groups,
// they can create the tab and then drag it outside the tab groups
chrome.tabs.onCreated.addListener(function (newTab)
{

    log(`New tab created: ${newTab.id} in window ${newTab.windowId}`);
    isNewTab = true;

    if (newTab.groupId !== -1)
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
        if (isFallbackTab(win, newTab, function (isFallback)
        {
            if (isFallback)
            {
                log("Ignoring fallback tab")
                return;
            }

            if (lastFocusedTabIds[newTab.windowId])
            {
                chrome.tabs.get(lastFocusedTabIds[newTab.windowId], function (lastFocusedTab)
                {

                    if (chrome.runtime.lastError)
                    {
                        error("Error retrieving tab: ", chrome.runtime.lastError);
                        return;
                    }

                    if (lastFocusedTab && lastFocusedTab.groupId !== -1)
                    {
                        log(`Adding new tab ${newTab.id} to group of last tab ${lastFocusedTab.groupId}`);

                        // Add the new tab to the group of the last focused tab
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
                // weird. just let the new tab be where it is
                warn("No last focused tab found for window " + newTab.windowId);
            }

        }));

    });

});
