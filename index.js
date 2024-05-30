import { registerSlashCommand, sendMessageAs } from "../../../slash-commands.js";
import { getContext } from "../../../extensions.js";
import { eventSource, event_types } from "../../../../script.js";
import { amount_gen, generateRaw, updateMessageBlock } from "../../../../script.js"

const SUMMARY_TEMPLATE = "Summarize the following youtube video in a few sentences, only keep key point information, do not explain or elaborate, do not use bulletpoints";

registerSlashCommand("ytsummary", (_, link) => {
    summarize(link)
}, ["ytsum"], "Summarizes a youtube video", true, true);

registerSlashCommand("ytdiscuss", (_, link) => {
    summarize(link, true)
}, ["ytdc"], "Summarizes a youtube video and allows to ask follow-up questions", true, true);

function youtube_parser(url) {
    const regex = /^.*(?:(?:youtu\.be\/|v\/|vi\/|u\/\w\/|embed\/|shorts\/)|(?:(?:watch)?\?v(?:i)?=|\&v(?:i)?=))([^#\&\?]*).*/;
    const match = url.match(regex);
    return (match?.length && match[1] ? match[1] : false);
}

function chunkMessage(str, length) {
    return str.match(new RegExp('.{1,' + length + '}', 'g'));
}

async function getTranscript(id) {
    const RE_XML_TRANSCRIPT = /<text start="([^"]*)" dur="([^"]*)">([^<]*)<\/text>/g;
    const lang = "en"; // feel free to PR a second argument to the slash command, I'm only interested in "en"
    const useragent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.3"

    if (!id) {
        console.log('Id is required for /transcript');
        return response.sendStatus(400);
    }

    const videoPageResponse = await fetch(`https://corsproxy.io/?https://www.youtube.com/watch?v=${id}`, {
        headers: {
            ...(lang && { 'Accept-Language': lang }),
            'User-Agent': useragent,
        },
    });

    const videoPageBody = await videoPageResponse.text();
    const splittedHTML = videoPageBody.split('"captions":');

    if (splittedHTML.length <= 1) {
        if (videoPageBody.includes('class="g-recaptcha"')) {
            throw new Error('Too many requests');
        }
        if (!videoPageBody.includes('"playabilityStatus":')) {
            throw new Error('Video is not available');
        }
        throw new Error('Transcript not available');
    }

    const captions = (() => {
        try {
            return JSON.parse(splittedHTML[1].split(',"videoDetails')[0].replace('\n', ''));
        } catch (e) {
            return undefined;
        }
    })()?.['playerCaptionsTracklistRenderer'];

    if (!captions) {
        throw new Error('Transcript disabled');
    }

    if (!('captionTracks' in captions)) {
        throw new Error('Transcript not available');
    }

    if (lang && !captions.captionTracks.some(track => track.languageCode === lang)) {
        throw new Error('Transcript not available in this language');
    }

    const transcriptURL = (lang ? captions.captionTracks.find(track => track.languageCode === lang) : captions.captionTracks[0]).baseUrl;
    const transcriptResponse = await fetch("https://corsproxy.io/?" + transcriptURL, {
        headers: {
            ...(lang && { 'Accept-Language': lang }),
            'User-Agent': useragent,
        },
    });

    if (!transcriptResponse.ok) {
        throw new Error('Transcript request failed');
    }

    const transcriptBody = await transcriptResponse.text();
    const results = [...transcriptBody.matchAll(RE_XML_TRANSCRIPT)];
    const transcript = results.map((result) => ({
        text: result[3],
        duration: parseFloat(result[2]),
        offset: parseFloat(result[1]),
        lang: lang ?? captions.captionTracks[0].languageCode,
    }));

    return transcript.map(x => x.text).join(" ")
}

async function summarizeChunks(text, chunkLength) {
    const chunks = chunkMessage(Array.isArray(text) ? text.join(" ") : text, chunkLength)
    const chunkedSummary = []
    const maxChunks = 10
    for (let index = 0; index < Math.min(chunks.length, maxChunks); index++) {
        toastr.info(`Processing ${index + 1} out of ${Math.min(chunks.length, maxChunks)}`)

        const chunk = chunks[index];
        const message = `${SUMMARY_TEMPLATE}:\n\n${chunk}`;
        const summary = await generateRaw(message, null, false)

        chunkedSummary.push(summary)
    }

    return chunkedSummary.join(" ")
}

async function summarize(link, post_into_chat = false) {
    if (!link) {
        toastr.warning("Please provide a youtube link to summarize")
        return
    }

    const youtube_id = youtube_parser(link);
    if (!youtube_id) {
        toastr.error("Invalid youtube link")
        return
    }

    toastr.info(`Getting transcript for ${youtube_id}...`)


    try {
        const context = getContext();
        const transcript = await getTranscript(youtube_id)
        const chunkLength = context.maxContext - amount_gen;

        if (post_into_chat) sendMessageAs({ name: context.name2 }, "[[TRANSCRIPT]]" + transcript);
        let summary = await summarizeChunks(transcript, chunkLength);

        if (summary.length > 2000) {
            toastr.info("Summary too long, summarizing again...")
            summary = await summarizeChunks(summary, chunkLength);
        }

        sendMessageAs({ name: context.name2 }, summary);
    } catch (err) {
        console.log("ytdlp", err)
        // TODO: fallback to whisper streaming with yt-dlp
        toastr.error("Could not load transcript from youtube")
    }
}

function interceptMessage(messageID) {
    const message = getContext().chat[messageID];
    if (message.mes.startsWith("[[TRANSCRIPT]]")) {
        message.extra = { ...message.extra, display_text: `[[[ youtube transcript ]]]` }
    }
    updateMessageBlock(messageID, message);
}

eventSource.on(event_types.MESSAGE_EDITED, interceptMessage);
eventSource.on(event_types.MESSAGE_SENT, interceptMessage);
eventSource.on(event_types.MESSAGE_RECEIVED, interceptMessage);
