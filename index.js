import { registerSlashCommand, sendMessageAs } from "../../../slash-commands.js";
import { getContext } from "../../../extensions.js";
import { eventSource, event_types } from "../../../../script.js";
import { amount_gen, generateRaw, updateMessageBlock, getRequestHeaders } from "../../../../script.js"

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
    const result = await fetch('/api/serpapi/transcript', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ id, lang: "en" }),
    });

    if (!result.ok) {
        const error = await result.text();
        toastr.error(error)
    }

    const transcript = await result.text();
    return transcript
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
