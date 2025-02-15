import { Tweet } from "agent-twitter-client";

export interface IConversationThread {
    messages: string[];
    lastMessageId?: string;
    lastMessageTimestamp?: number;
}

export function buildConversationThread(tweets: Tweet[]): IConversationThread {
    const sortedTweets = tweets.sort((a, b) => {
        const timestampA = a.timestamp ? new Date(a.timestamp).getTime() : 0;
        const timestampB = b.timestamp ? new Date(b.timestamp).getTime() : 0;
        return timestampA - timestampB;
    });

    const messages = sortedTweets.map(tweet => `${tweet.username || 'Unknown'}: ${tweet.text || ''}`);
    const lastTweet = sortedTweets[sortedTweets.length - 1];

    return {
        messages,
        lastMessageId: lastTweet?.id,
        lastMessageTimestamp: lastTweet?.timestamp ? new Date(lastTweet.timestamp).getTime() : undefined
    };
}

export function addMessageToThread(thread: IConversationThread, tweet: Tweet): IConversationThread {
    return {
        messages: [...thread.messages, `${tweet.username || 'Unknown'}: ${tweet.text || ''}`],
        lastMessageId: tweet.id,
        lastMessageTimestamp: tweet.timestamp ? new Date(tweet.timestamp).getTime() : thread.lastMessageTimestamp
    };
} 