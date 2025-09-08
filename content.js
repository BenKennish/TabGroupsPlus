// Tab Groups Plus
// content script

// cannot use import statements in content script as it's not a module
//import { CONSOLE_PREFIX } from './shared.js';

if (!window.isInjected)
{
    window.isInjected = true;

    // Function to handle mouseenter event
    function handleMouseEnter()
    {
        //console.debug('[TabGroupsPlus] Mouse entered content area - sending message to background script');
        if (window.isInjected)
        {
            chrome.runtime.sendMessage({ action: 'mouseInContentArea', value: true });  // extension context invalidated occurs here
        }
    }
    document.documentElement.addEventListener('mouseenter', handleMouseEnter);

    // Function to handle mouseenter event
    function handleMouseLeave()
    {
        //console.debug('[TabGroupsPlus] Mouse left content area - sending message to background script');
        if (window.isInjected)
        {
            chrome.runtime.sendMessage({ action: 'mouseInContentArea', value: false });  // extension context invalidated occurs here
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
        console.log('[TGP] Listeners removed');
    });

    console.log('[TGP] Content script loaded');
}
else
{
    console.log('[TGP] Content script already loaded');
}