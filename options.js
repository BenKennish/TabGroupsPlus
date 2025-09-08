import { DEFAULT_OPTIONS, CONSOLE_PREFIX } from './shared.js';

document.addEventListener('DOMContentLoaded', function ()
{
    // Load saved options
    chrome.storage.sync.get(DEFAULT_OPTIONS, function (options)
    {
        console.log(`${CONSOLE_PREFIX} Updating HTML to match options...`, options);

        // update the HTML to match the options
        document.getElementById('doCompactOnActivateUngroupedTab').checked = options.doCompactOnActivateUngroupedTab;
        document.getElementById('alignActiveTabGroup').value = options.alignActiveTabGroup;
        document.getElementById('delayCompactOnEnterContentAreaMs').value = options.delayCompactOnEnterContentAreaMs;
        document.getElementById('delayCompactOnActivateUninjectedTabMs').value = options.delayCompactOnActivateUninjectedTabMs;
        document.getElementById('autoGroupNewTabs').checked = options.autoGroupNewTabs;
    });

    // Save options when the form is submitted
    document.getElementById('options-form').addEventListener('submit', (event) =>
    {
        event.preventDefault();

        let optionsToSave = {
            doCompactOnActivateUngroupedTab: document.getElementById('doCompactOnActivateUngroupedTab').checked,
            alignActiveTabGroup: parseInt(document.getElementById('alignActiveTabGroup').value, 10),
            delayCompactOnEnterContentAreaMs: parseInt(document.getElementById('delayCompactOnEnterContentAreaMs').value, 10),
            delayCompactOnActivateUninjectedTabMs: parseInt(document.getElementById('delayCompactOnActivateUninjectedTabMs').value, 10),
            autoGroupNewTabs: document.getElementById('autoGroupNewTabs').checked
        }

        chrome.storage.sync.set(optionsToSave, () =>
        {
            // background.js has a listener for the storage being updated so we don't need to do anything here
            window.close();
        });
    });

    // Close window when cancel button clicked
    document.getElementById('cancel').addEventListener('click', (event) =>
    {
        event.preventDefault();
        window.close();
    });
});
