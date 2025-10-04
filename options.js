import { DEFAULT_OPTIONS, CONSOLE_PREFIX } from './shared.js';

document.addEventListener('DOMContentLoaded', function ()
{
    // Load saved options
    chrome.storage.sync.get(DEFAULT_OPTIONS, function (options)
    {
        console.log(`${CONSOLE_PREFIX} Updating HTML controls to match options object...`, options);

        document.getElementById('compactOnActivateUngroupedTab').checked = options.compactOnActivateUngroupedTab;
        document.getElementById('collapsePreviousActiveGroupOnActivateUngroupedTab').checked = options.collapsePreviousActiveGroupOnActivateUngroupedTab;
        document.getElementById('alignActiveTabGroup').value = options.alignActiveTabGroup;
        document.getElementById('delayCompactOnEnterContentAreaMs').value = options.delayCompactOnEnterContentAreaMs;
        document.getElementById('delayCompactOnActivateUninjectedTabMs').value = options.delayCompactOnActivateUninjectedTabMs;
        document.getElementById('autoGroupNewTabs').checked = options.autoGroupNewTabs;
    });

    // Save options when the form is submitted
    document.getElementById('options-form').addEventListener('submit', (event) =>
    {
        // onSubmit...

        event.preventDefault();

        const optionsToSave = {
            compactOnActivateUngroupedTab: document.getElementById('compactOnActivateUngroupedTab').checked,
            collapsePreviousActiveGroupOnActivateUngroupedTab: document.getElementById('collapsePreviousActiveGroupOnActivateUngroupedTab').checked,
            alignActiveTabGroup: parseInt(document.getElementById('alignActiveTabGroup').value, 10),
            delayCompactOnEnterContentAreaMs: parseInt(document.getElementById('delayCompactOnEnterContentAreaMs').value, 10),  // base 10
            delayCompactOnActivateUninjectedTabMs: parseInt(document.getElementById('delayCompactOnActivateUninjectedTabMs').value, 10), // base 10
            autoGroupNewTabs: document.getElementById('autoGroupNewTabs').checked
        }

        chrome.storage.sync.set(optionsToSave, () =>
        {
            if (chrome.runtime.lastError)
            {
                console.error(`${CONSOLE_PREFIX} Error setting options in storage:`, chrome.runtime.lastError.message);
            }

            // background.js has a listener for the storage being updated so we just close the options window
            // and let it handle it
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
