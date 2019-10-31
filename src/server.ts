// standard server modules
import express = require('express');
const app = express();
const chalk = require('chalk');
const fs = require('fs');
require('dotenv').config();
const log = require('loglevel');
log.setLevel(process.env.LOG_LEVEL ? process.env.LOG_LEVEL : 'info');

if (!process.env.ACCOUNT_USERNAME ||
    !process.env.PASSWORD ||
    !process.env.CLIENT_ID ||
    !process.env.CLIENT_SECRET ||
    !process.env.NODE_ENV ||
    !process.env.MONGODB_URI ||
    !process.env.NODE_ENV ||
    !process.env.DAYS_EXPIRY ||
    !process.env.EXTERNAL_DATABASES
    ) {
        log.error(
            process.env.ACCOUNT_USERNAME,
            process.env.PASSWORD,
            process.env.CLIENT_ID,
            process.env.CLIENT_SECRET,
            process.env.NODE_ENV,
            process.env.MONGODB_URI,
            process.env.NODE_ENV,
            process.env.DAYS_EXPIRY,
            process.env.EXTERNAL_DATABASES
        );
        throw "Missing essential config. Fatal error."
}


// magic eye modules
import { initDatabase } from './mongodb_data';
import { processSubmission } from './submission_processor';
import { processInboxMessage } from './inbox_processor';
import { processUnmoderated } from './unmoderated_processor';
import { firstTimeInit, isAnythingInitialising } from './first_time_init';
import { SubredditSettings, getSubredditSettings, setSubredditSettings,
    getMasterProperty, setMasterProperty, initMasterDatabase,
    refreshDatabaseList, upgradeMasterSettings, needsUpgrade } from './mongodb_master_data';
import { updateSettings, createDefaultSettings, writeSettings } from './wiki_utils';
import { logProcessPost, logProcessCycle, printStats } from './master_stats';
import { getModdedSubredditsMulti } from './modded_subreddits';

// Create a new snoowrap requester with OAuth credentials
// See here: https://github.com/not-an-aardvark/reddit-oauth-helper
const snoowrap = require('snoowrap');
const reddit = new snoowrap({
    userAgent: 'THE_MAGIC_EYE:v1.0.1',
    clientId: process.env.CLIENT_ID,
    clientSecret: process.env.CLIENT_SECRET,
    username: process.env.ACCOUNT_USERNAME,
    password: process.env.PASSWORD
}); 
reddit.config({requestDelay: 1000, continueAfterRatelimitError: true});
if (process.env.LOG_LEVEL == 'debug') {
    reddit.config({debug: true})
}


async function main() {
    let timeoutTimeSeconds = 30;
    try {
        log.debug(chalk.blue("Starting Magic processing cycle"));
        const startCycleTime = new Date().getTime();
        
        const moddedSubs = await getModdedSubredditsMulti(reddit);
        if (moddedSubs.length == 0) {
            log.warn('No subreddits found. Sleeping.');
            setTimeout(main, 30 * 1000); // run again in 30 seconds
        }
        const moddedSubredditsMultiString = moddedSubs.map(sub => sub + "+").join("").slice(0, -1); // rarepuppers+pics+MEOW_IRL
        const subredditMulti = await reddit.getSubreddit(moddedSubredditsMultiString);

        const submissions = await subredditMulti.getNew({'limit': 90});
        if (!submissions) {
            log.error(chalk.red('Cannot get new submissions to process - api is probably down for maintenance.'));
            setTimeout(main, 30 * 1000); // run again in 30 seconds
            return;
        }

        await doNewSubmissionProcessing(moddedSubs, submissions);
        await doInboxProcessing();
        await updateSettings(subredditMulti, reddit);

        // end cycle
        const endCycleTime = new Date().getTime();
        const cycleTimeTaken = (endCycleTime - startCycleTime) / 1000;
        timeoutTimeSeconds = Math.max(timeoutTimeSeconds - cycleTimeTaken, 0);

        if (cycleTimeTaken > 30) {
            log.warn('========= TIME WARNING: cycle was ', cycleTimeTaken, 'seconds');
        } else {
            log.warn('========= Cycle finished, time was ', cycleTimeTaken, 'seconds');
        }
        logProcessCycle(cycleTimeTaken);

        log.debug(chalk.green('End Magic processing cycle, running again soon.'));
    } catch (err) {
        log.error(chalk.red("Main loop error: ", err));
    }
    
    setTimeout(main, timeoutTimeSeconds * 1000); // run again in timeoutTimeSeconds
}

async function doNewSubmissionProcessing(moddedSubs: string[], submissions: any) {
    const unprocessedSubmissions = await consumeUnprocessedSubmissions(submissions); 
    const startTime = new Date().getTime();
    for (const subredditName of moddedSubs) {
        const unprocessedForSub = unprocessedSubmissions.filter(submission => submission.subreddit.display_name == subredditName);
        try {                
            await processSubreddit(subredditName, unprocessedForSub, reddit);
        } catch (e) {
            const possibleErrorIds = unprocessedForSub.map(item => item.id);
            log.error('Error processing subreddit: ', subredditName, ',', e, ', possible error threads:', possibleErrorIds);
        }
    }
    const endTime = new Date().getTime();
    const getSubmissionsTimeTaken = (endTime - startTime) / 1000;
    log.info(chalk.blue('========= Processed', unprocessedSubmissions.length, ' new submissions, took: ', getSubmissionsTimeTaken));
}

async function doInboxProcessing() {
    // inbox
    const startInboxTime = new Date().getTime();
    try {
        const unreadMessages = await reddit.getUnreadMessages();
        if (!unreadMessages) {
            log.error(chalk.red('Cannot get new inbox items to process - api is probably down for maintenance.'));
            return;
        }
        if (unreadMessages.length > 0) {
            await reddit.markMessagesAsRead(unreadMessages);
        }
        for (let message of unreadMessages) {
            const messageSubreddit = await message.subreddit;
            let database = null;
            let masterSettings = null;
            if (messageSubreddit) {
                const messageSubredditName = await messageSubreddit.display_name;
                masterSettings = await getSubredditSettings(messageSubredditName);                 
                if (masterSettings) {
                    database = await initDatabase(messageSubredditName, masterSettings.config.databaseUrl);
                }
            }
            await processInboxMessage(message, reddit, database, messageSubreddit, masterSettings);
        }
        const endInboxTime = new Date().getTime();
        const getTimeTaken = (endInboxTime - startInboxTime) / 1000;
        log.info(chalk.blue('========= Processed', unreadMessages.length, ' new inbox messages, took: ', getTimeTaken));
    } catch (err) {
        log.error(chalk.red("Main loop error - INBOX processing: ", err));
    }
}

async function processSubreddit(subredditName: string, unprocessedSubmissions, reddit) {
    if (subredditName.startsWith('u_')) {
        return;
    }
    let masterSettings = await getSubredditSettings(subredditName);
    if (!masterSettings) {
        masterSettings = await initialiseNewSubreddit(subredditName);
    }

    // safe check
    if (!masterSettings.settings || !masterSettings.config) {
        log.warn(`[${subredditName}]`, chalk.yellow('Missing settings for '), subredditName, ' - ignoring subreddit');
        return;
    }

    if (needsUpgrade(masterSettings)) {
        masterSettings = upgradeMasterSettings(masterSettings);
        await writeSettings(subredditName, masterSettings, reddit);
        await setSubredditSettings(subredditName, masterSettings);
    }
    
    // first time init
    if (!masterSettings.config.firstTimeInit) {
        if (!isAnythingInitialising()) {
            const database = await initDatabase(subredditName, masterSettings.config.databaseUrl);
            firstTimeInit(reddit, subredditName, database, masterSettings).then(() => {
                log.info(`[${subredditName}]`, chalk.green('Initialisation processing exited for ', subredditName));
              }, (e) => {
                log.error(`[${subredditName}]`, chalk.red('First time init failed for:', subredditName, e));
              });
        }
        return;
    }

    // unmoderated
    if (masterSettings.settings.reportUnmoderated) {
        if (masterSettings.config.reportUnmoderatedTime > 40) {
            const subForUnmoderated = await reddit.getSubreddit(subredditName);
            const topSubmissionsDay = await subForUnmoderated.getTop({time: 'day'}).fetchAll({amount: 100});
            masterSettings.config.reportUnmoderatedTime = 0;
            await setSubredditSettings(subredditName, masterSettings); // set now in case of api error
            await processUnmoderated(topSubmissionsDay, masterSettings.settings, subredditName);
        } else {
            masterSettings.config.reportUnmoderatedTime++;
            await setSubredditSettings(subredditName, masterSettings);
        }
    }

    // submissions
    if (unprocessedSubmissions.length > 0) {
        const database = await initDatabase(subredditName, masterSettings.config.databaseUrl);
        if (database) {
            for (let submission of unprocessedSubmissions) {
                const startTime = new Date().getTime();                
                await processSubmission(submission, masterSettings, database, reddit, true);
                const endTime = new Date().getTime();
                const timeTaken = (endTime - startTime) / 1000;
                logProcessPost(subredditName, timeTaken);                
            };
        } else {
            log.error(`[${subredditName}]`, chalk.red(`Failed to init database, ignoring ${unprocessedSubmissions.length} posts for subreddit.`));
        }
    }
}

async function initialiseNewSubreddit(subredditName: string) {
    // find the database with least use
    log.info(`[${subredditName}]`, chalk.yellow('No master settings for'), subredditName, ' - searching for least used database');
    const databaseList = await getMasterProperty('databases');
    let selectedDatabase = null;
    let databaseCount = 99999;
    for (const databaseKey of Object.keys(databaseList)) {
        const database = databaseList[databaseKey];
        if (database.count < databaseCount) {
            selectedDatabase = database;
            databaseCount = database.count;
        }
    }
    if (!selectedDatabase) {
        log.warn(`[${subredditName}]`, 'No databases available to house: ', subredditName);
        return;            
    }
    const masterSettings = new SubredditSettings(subredditName);
    await createDefaultSettings(subredditName, masterSettings, reddit);
    
    masterSettings.config.databaseUrl = selectedDatabase.url;
    await setSubredditSettings(subredditName, masterSettings);
    selectedDatabase.count++;
    await setMasterProperty('databases', databaseList);
    return masterSettings;
}

async function consumeUnprocessedSubmissions(latestItems) {
    latestItems.sort((a, b) => { return a.created_utc - b.created_utc}); // oldest first

    const maxCheck = 500;
    if (latestItems.length > maxCheck) {
        log.info('Passed more than maxCheck items:', latestItems.length);
        latestItems = latestItems.slice(latestItems.length - maxCheck, latestItems.length);
    }

    // don't process anything over 3 hours old for safeguard. created_utc is in seconds/getTime is in millis.
    const threeHoursAgo = new Date().getTime() - 1000*60*60*3;
    latestItems = latestItems.filter(item => (item.created_utc * 1000) > threeHoursAgo); 

    const processedIds = await getMasterProperty('new_processed_ids');
    if (!processedIds) {
        log.warn(chalk.magenta('Could not find the last processed id list when retrieving unprocessed submissions. Regenerating...'));
        const intialProcessedIds = latestItems.map(submission => submission.id);
        await setMasterProperty('new_processed_ids', intialProcessedIds);
        return [];
    }  

    // update the processed list before processing so we don't retry any submissions that cause exceptions
    const newItems = latestItems.filter(item => !processedIds.includes(item.id));
    let updatedProcessedIds = processedIds.concat(newItems.map(submission => submission.id)); // [3,2,1] + [new] = [3,2,1,new]
    const processedCacheSize = maxCheck*5; // larger size for any weird/future edge-cases where a mod removes a lot of submissions
    if (updatedProcessedIds.length > processedCacheSize) { 
        updatedProcessedIds = updatedProcessedIds.slice(updatedProcessedIds.length - processedCacheSize); // [3,2,1,new] => [2,1,new]
    }
    await setMasterProperty('new_processed_ids', updatedProcessedIds);
    
    if (newItems.length > 50) {
        log.warn('WARNING: Queue appears backlogged with more than 50 items');
    }

    return newItems;
}


// server
async function startServer() {   
    try {
        app.listen(process.env.PORT || 3000, () => log.info(chalk.bgGreenBright('Magic Eye listening on port 3000')));

        const tempDir = './tmp';
        if (!fs.existsSync(tempDir)) {
            fs.mkdirSync(tempDir);
        }

        await initMasterDatabase();   
        await refreshDatabaseList();

        log.info('The magic eye is ONLINE.');
        main(); // start mains loop
    } catch (e) {
        log.error(chalk.red(e));
    }
}
startServer();

app.get('/keepalive', async function(req, res) {
    res.setHeader('Content-Type', 'application/json');
    res.send(JSON.stringify({ status: 'ok' }));
});

app.get('/stats/print', async function(req, res) {
    printStats();
    res.setHeader('Content-Type', 'application/json');
    res.send(JSON.stringify({ status: 'Printed!' }));
});



process.on('unhandledRejection', (reason, p) => {
    log.warn('Unhandled Rejection at: Promise', p, 'reason:', reason);
  });