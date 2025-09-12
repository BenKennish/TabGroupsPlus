// Tab Groups Plus
// content script

// cannot use import statements in content script as it's not a module
//import { CONSOLE_PREFIX } from './shared.js';

if (!window.isInjected)
{
    // we are running so mark the window as injected
    window.isInjected = true;

    // NOTE: using named functions for the event listeners so we can remove them later using removeEventListener

    // Function to handle mouseenter event
    function onMouseEnter()
    {
        //console.debug('[TGP] Mouse entered content area - sending message to background script');
        if (window.isInjected)
        {
            chrome.runtime.sendMessage({ action: 'mouseInContentArea', value: true });
        }
    }
    document.documentElement.addEventListener('mouseenter', onMouseEnter);

    // Function to handle mouseleave event
    function onMouseLeave()
    {
        //console.debug('[TGP] Mouse left content area - sending message to background script');
        if (window.isInjected)
        {
            chrome.runtime.sendMessage({ action: 'mouseInContentArea', value: false });
        }
    }
    document.documentElement.addEventListener('mouseleave', onMouseLeave);

    // used to handle pings from background.js,
    // to check whether the content script is hooked into the current tab
    function onMessage(message, sender, sendResponse)
    {
        if (window.isInjected && message.action === "ping")
        {
            sendResponse({ status: "ok" });
        }
    }
    chrome.runtime.onMessage.addListener(onMessage);


    window.addEventListener('beforeunload', () =>
    {
        // clean up just before window is unloaded
        window.isInjected = false;
        document.documentElement.removeEventListener('mouseenter', onMouseEnter);
        document.documentElement.removeEventListener('mouseleave', onMouseLeave);
        chrome.runtime.onMessage.removeListener(onMessage);
        console.log('[TGP] Listeners removed');
    });

    console.log('[TGP] Content script loaded into active tab');
}
else
{
    console.log('[TGP] Content script already loaded in active tab');
}