// does this property of window get reset when the script is uninjected?
if (!window.isInjected)
{
    window.isInjected = true;

    window.addEventListener('beforeunload', () =>
    {
        // clean up just before window is unloaded
        window.isInjected = false;
        document.documentElement.removeEventListener('mouseenter', handleMouseEnter);
    });

    // Function to handle mouseenter event
    function handleMouseEnter()
    {
        //console.log('[TabGroupsPlus] Mouse entered content area - sending message to background script');
        chrome.runtime.sendMessage({ action: 'mouseInContentArea', value: true });
    }

    document.documentElement.addEventListener('mouseenter', handleMouseEnter);

    // handler for pings from background.js,
    // used to check whether the content script is hooked into the current tab
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) =>
    {
        if (window.isInjected && message.action === "ping")
        {
            sendResponse({ status: "ok" });
        }
    });

    console.log('[TabGroupsPlus] Content script loaded');
}
else
{
    console.log('[TabGroupsPlus] Content script already loaded');
}