import { type Tweet } from "agent-twitter-client";
import { 
    type IAgentRuntime, 
    type Memory, 
    type Content, 
    elizaLogger,
    stringToUuid,
    getEmbeddingZeroVector,
    type UUID
} from "@elizaos/core";
import { ClientBase } from "../base";
import { TwitterInteractionClient } from "../interactions";
import { KeywordActionPlugin } from "./KeywordActionPlugin";
import { sendTweet, buildConversationThread } from "../utils";

export class TwitterKeywordService extends TwitterInteractionClient {
    private keywordPlugin: KeywordActionPlugin;

    constructor(client: ClientBase, runtime: IAgentRuntime) {
        super(client, runtime);
        this.keywordPlugin = new KeywordActionPlugin(client, runtime);
    }

    // Method to register new keyword actions
    registerKeywordAction(keywords: string[], action: (tweet: Tweet, runtime: IAgentRuntime) => Promise<{
        response: string;
        data?: any;
    }>) {
        this.keywordPlugin.registerAction({ keywords, action });
    }

    // Override the handleTweet method to include keyword processing
    public async handleTweet({
        tweet,
        message,
        thread,
    }: {
        tweet: Tweet;
        message: Memory;
        thread: Tweet[];
    }): Promise<{ text: string; action: string }> {
        // First check for keyword actions
        const keywordResult = await this.keywordPlugin.processTweet(tweet);
        
        if (keywordResult.hasAction && keywordResult.response) {
            await sendTweet(
                this.client,
                { text: keywordResult.response },
                stringToUuid(tweet.id + "-" + this.runtime.agentId),
                this.client.twitterConfig.TWITTER_USERNAME,
                tweet.id
            );
            return { text: keywordResult.response, action: keywordResult.action };
        }

        // If no keyword actions matched, handle normally using parent class
        return super.handleTweet({ tweet, message, thread });
    }

    // Start the service with keyword processing
    async start() {
        const handleTwitterInteractionsLoop = async () => {
            try {
                const tweets = await this.client.fetchTimelineForActions(100);
                
                for (const tweet of tweets) {
                    const userId = stringToUuid(tweet.userId);
                    const roomId = stringToUuid(tweet.id + "-" + this.runtime.agentId);

                    // Ensure the user and room exist
                    await this.runtime.ensureConnection(
                        userId,
                        roomId,
                        tweet.username,
                        tweet.name,
                        "twitter"
                    );

                    const content: Content = {
                        text: tweet.text || "",
                        url: tweet.permanentUrl,
                        source: "twitter",
                        inReplyTo: tweet.inReplyToStatusId
                            ? stringToUuid(tweet.inReplyToStatusId + "-" + this.runtime.agentId)
                            : undefined,
                    };

                    // Create memory for the tweet
                    const memory = {
                        id: stringToUuid(tweet.id + "-" + this.runtime.agentId),
                        userId,
                        content,
                        agentId: this.runtime.agentId,
                        roomId,
                        embedding: getEmbeddingZeroVector(),
                        createdAt: tweet.timestamp ? tweet.timestamp * 1000 : Date.now(),
                    };

                    await this.runtime.messageManager.createMemory(memory);

                    const thread = await buildConversationThread(tweet, this.client);
                    
                    await this.handleTweet({
                        tweet,
                        message: memory,
                        thread,
                    });
                }

                elizaLogger.log("Finished processing Twitter interactions");
            } catch (error) {
                elizaLogger.error("Error in Twitter keyword service:", error);
            }
        };

        // Start the interaction loop
        handleTwitterInteractionsLoop();
        setInterval(handleTwitterInteractionsLoop, 60000); // Check every minute
    }
}

// Example usage:
/*
const twitterService = new TwitterKeywordService(client, runtime);

// Register keyword actions
twitterService.registerKeywordAction(
    ["help", "commands"],
    async (tweet, runtime) => {
        return {
            response: "Here are the available commands: ...",
        };
    }
);

// Start the service
await twitterService.start();
*/ 