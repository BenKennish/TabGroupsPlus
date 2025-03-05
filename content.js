/*
if (window.hasRunTGPContentScript)
{
    // Already injected, so do nothing.
    return;
}
window.hasRunTGPContentScript = true;
*/

// Function to handle mouseenter event
function handleMouseEnter()
{
    // send message to the background script
    chrome.runtime.sendMessage({ action: 'mouseInContentArea', value: true });
}

document.documentElement.addEventListener('mouseenter', handleMouseEnter);


// ping handler for checking whether the content script is hooked into the current tab
chrome.runtime.onMessage.addListener((message, sender, sendResponse) =>
{
    if (message.action === "ping")
    {
        sendResponse({ status: "ok" });
    }
});


console.log('[TabGroupsPlus] Content script loaded');