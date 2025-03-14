// TabGroupsPlus
// content script

// does this property of window get reset when the script is uninjected?
if (!window.isInjected)
{
    window.isInjected = true;

    // Function to handle mouseenter event
    function handleMouseEnter()
    {
        //console.log('[TabGroupsPlus] Mouse entered content area - sending message to background script');

        if (window.isInjected)
        {
            chrome.runtime.sendMessage({ action: 'mouseInContentArea', value: true });
        }
    }
    document.documentElement.addEventListener('mouseenter', handleMouseEnter);

    // Function to handle mouseenter event
    function handleMouseLeave()
    {
        //console.log('[TabGroupsPlus] Mouse left content area - sending message to background script');
        if (window.isInjected)
        {
            chrome.runtime.sendMessage({ action: 'mouseInContentArea', value: false });
        }
    }
    document.documentElement.addEventListener('mouseleave', handleMouseLeave);


    // handler for pings from background.js,
    // used to check whether the content script is hooked into the current tab
    function pingHandler(message, sender, sendResponse)
    {
        if (window.isInjected && message.action === "ping")
        {
            sendResponse({ status: "ok" });
        }
    }
    chrome.runtime.onMessage.addListener(pingHandler);

    window.addEventListener('beforeunload', () =>
    {
        // clean up just before window is unloaded
        window.isInjected = false;
        document.documentElement.removeEventListener('mouseenter', handleMouseEnter);
        document.documentElement.removeEventListener('mouseleave', handleMouseLeave);
        chrome.runtime.onMessage.removeListener(pingHandler);
    });

    console.log('[TabGroupsPlus] Content script loaded');
}
else
{
    console.log('[TabGroupsPlus] Content script already loaded');
}