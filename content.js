// Tab Groups Plus
// content script

// we can't use import statements in content script as it's not a module
// we just define it as a constant here
//import { CONSOLE_PREFIX } from './shared.js';
const CONSOLE_PREFIX = "[TGP]"

if (!window.isInjected)
{
    // we are running so mark the window as injected
    window.isInjected = true

    // NOTE: we use named functions for the event listeners so we can remove them later using removeEventListener

    // Function to handle mouseenter event
    function onMouseEnter()
    {
        //console.debug('[TGP] Mouse entered content area - sending message to background script');
        if (window.isInjected)
        {
            chrome.runtime.sendMessage({ action: 'mouseInContentArea', value: true })
        }
    }

    // Function to handle mouseleave event
    function onMouseLeave()
    {
        //console.debug('[TGP] Mouse left content area - sending message to background script');
        if (window.isInjected)
        {
            chrome.runtime.sendMessage({ action: 'mouseInContentArea', value: false })
        }
    }

    // used to handle pings from background.js,
    // to check whether the content script is hooked into the current tab
    function onMessageReceived(message, sender, sendResponse)
    {
        if (window.isInjected)
        {
            if (message.action && message.action === "ping")
            {
                sendResponse({ status: "pong" })
            }
            else
            {
                sendResponse({ status: "unexpected action: " + message.action })
            }
        }
    }

    // register listeners
    document.documentElement.addEventListener('mouseenter', onMouseEnter)
    document.documentElement.addEventListener('mouseleave', onMouseLeave)
    chrome.runtime.onMessage.addListener(onMessageReceived)


    window.addEventListener('beforeunload', () =>
    {
        // clean up just before window is unloaded
        window.isInjected = false
        document.documentElement.removeEventListener('mouseenter', onMouseEnter)
        document.documentElement.removeEventListener('mouseleave', onMouseLeave)
        chrome.runtime.onMessage.removeListener(onMessageReceived)
        console.log(CONSOLE_PREFIX + ' Listeners removed')
    })

    console.log(CONSOLE_PREFIX + ' Content script loaded into active tab')
}
else
{
    console.log(CONSOLE_PREFIX + ' Content script already loaded in active tab')
}