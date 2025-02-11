import { type Tweet } from "agent-twitter-client";
import { 
    type IAgentRuntime,
    elizaLogger,
    type Memory,
    type Content,
    stringToUuid
} from "@elizaos/core";
import { ClientBase } from "../base";
import { MovebotPlugin } from "./MovebotPlugin";
import { TwitterInteractionClient } from "../interactions";
import { SearchMode } from "agent-twitter-client";
import { buildConversationThread, sendTweet } from "../utils";
import { TokenTransferPlugin } from "./TokenTransferPlugin";

export class MovebotService extends TwitterInteractionClient {
    private movebotPlugin: MovebotPlugin;
    private tokenTransferPlugin: TokenTransferPlugin;
    private lastProcessedTweetId: string | null = null;
    private processingLock: boolean = false;
    private static readonly BATCH_SIZE = 20;

    constructor(client: ClientBase, runtime: IAgentRuntime) {
        super(client, runtime);
        this.tokenTransferPlugin = new TokenTransferPlugin(client, runtime);
        this.movebotPlugin = new MovebotPlugin(client, runtime);
        
        // Register token transfer actions with the movebot plugin
        const tokenActions = this.tokenTransferPlugin.getRegisteredActions();
        tokenActions.forEach(action => this.movebotPlugin.registerKeywordAction(action));
        
        elizaLogger.info("MovebotService: Initialized with TokenTransferPlugin");
    }

    private async fetchRelevantTweets(): Promise<Tweet[]> {
        try {
            // Ensure we're logged in before making any API calls
            if (!await this.ensureLogin()) {
                elizaLogger.error("MovebotService: Failed to ensure login, will retry in next cycle");
                return [];
            }

            elizaLogger.info("MovebotService: Starting to fetch mentions");
            const username = this.client.twitterConfig.TWITTER_USERNAME;
            
            // Use the request queue to handle rate limiting
            const mentionsResponse = await this.client.requestQueue.add(async () => {
                try {
                    const response = await this.client.fetchSearchTweets(
                        `@${username}`,
                        MovebotService.BATCH_SIZE,
                        SearchMode.Latest
                    );
                    return response;
                } catch (error) {
                    elizaLogger.error("MovebotService: Error fetching mentions:", {
                        error: error.message,
                        stack: error.stack
                    });
                    return { tweets: [] };
                }
            });

            if (!mentionsResponse.tweets || mentionsResponse.tweets.length === 0) {
                elizaLogger.debug("MovebotService: No mentions found");
                return [];
            }

            // Filter out tweets we've already processed
            const newTweets = this.lastProcessedTweetId
                ? mentionsResponse.tweets.filter(t => BigInt(t.id) > BigInt(this.lastProcessedTweetId))
                : mentionsResponse.tweets;

            if (newTweets.length > 0) {
                // Update the last processed ID to the most recent tweet
                this.lastProcessedTweetId = newTweets[0].id;
                elizaLogger.info(`MovebotService: Found ${newTweets.length} new mentions to process`);
            }

            return newTweets;
        } catch (error) {
            elizaLogger.error("MovebotService: Error fetching mentions:", {
                error: error.message,
                stack: error.stack
            });
            return [];
        }
    }

    private async processSingleTweet(tweet: Tweet): Promise<void> {
        try {
            elizaLogger.info(`MovebotService: Processing tweet ${tweet?.id}`);
            if (!tweet?.userId || !tweet?.id) {
                elizaLogger.warn("MovebotService: Invalid tweet object, skipping:", tweet);
                return;
            }

            const memoryId = stringToUuid(tweet.id + "-" + this.runtime.agentId);
            
            // Check if we've already processed this tweet
            const existingMemory = await this.runtime.messageManager.getMemoryById(memoryId);
            if (existingMemory) {
                elizaLogger.debug("MovebotService: Tweet already processed, skipping:", tweet.id);
                return;
            }

            elizaLogger.info(`MovebotService: Processing new tweet from @${tweet.username}`);
            const userId = stringToUuid(tweet.userId);
            const roomId = stringToUuid(tweet.id + "-" + this.runtime.agentId);

            // Ensure user connection exists with fallback values
            await this.runtime.ensureConnection(
                userId,
                roomId,
                tweet.username || "unknown_user",
                tweet.name || "Unknown User",
                "twitter"
            );

            // Create memory object
            const memory: Memory = {
                id: memoryId,
                userId,
                content: {
                    text: tweet.text || "",
                    url: tweet.permanentUrl,
                    source: "twitter",
                    inReplyTo: tweet.inReplyToStatusId
                        ? stringToUuid(tweet.inReplyToStatusId + "-" + this.runtime.agentId)
                        : undefined,
                },
                agentId: this.runtime.agentId,
                roomId,
                embedding: null,
                createdAt: tweet.timestamp ? tweet.timestamp * 1000 : Date.now(),
            };

            // Save memory
            await this.runtime.messageManager.createMemory(memory);

            // Build conversation thread
            const thread = await buildConversationThread(tweet, this.client);

            // Process the tweet through Movebot's handler
            await this.handleTweet({ 
                tweet, 
                message: memory, 
                thread: Array.isArray(thread) ? thread : [] 
            });

        } catch (error) {
            elizaLogger.error("MovebotService: Error processing tweet:", {
                tweetId: tweet?.id,
                error: error.message,
                stack: error.stack
            });
            throw error;
        }
    }

    public override async start(): Promise<void> {
        elizaLogger.info("MovebotService: Starting service");
        
        // Initial login attempt
        if (!await this.ensureLogin()) {
            elizaLogger.error("MovebotService: Failed to initialize, retrying in 30 seconds");
            setTimeout(() => this.start(), 30000);
            return;
        }

        const processTweets = async () => {
            if (this.processingLock) {
                elizaLogger.debug("MovebotService: Tweet processing already in progress, skipping");
                return;
            }

            elizaLogger.info("MovebotService: Starting tweet processing cycle");
            this.processingLock = true;
            
            try {
                const tweets = await this.fetchRelevantTweets();
                elizaLogger.info(`MovebotService: Processing batch of ${tweets.length} tweets`);
                
                for (const tweet of tweets) {
                    try {
                        await this.processSingleTweet(tweet);
                    } catch (tweetError) {
                        elizaLogger.error("MovebotService: Error processing tweet:", {
                            tweetId: tweet?.id,
                            error: tweetError.message,
                            stack: tweetError.stack
                        });
                        continue;
                    }
                }
            } catch (error) {
                elizaLogger.error("MovebotService: Error in processing cycle:", {
                    error: error.message,
                    stack: error.stack
                });
            } finally {
                this.processingLock = false;
                elizaLogger.info("MovebotService: Released processing lock");
            }
        };

        // Initial processing
        await processTweets();

        // Set up interval for subsequent processing
        const interval = setInterval(async () => {
            try {
                await processTweets();
            } catch (error) {
                elizaLogger.error("MovebotService: Error in processing interval:", error);
                // If we hit a critical error, try to restart the service
                clearInterval(interval);
                await this.start();
            }
        }, TwitterInteractionClient.PROCESSING_INTERVAL);

        elizaLogger.info(`MovebotService: Set up processing interval (${TwitterInteractionClient.PROCESSING_INTERVAL}ms)`);
    }

    protected override async ensureLogin(): Promise<boolean> {
        try {
            // First check if we're already logged in
            if (await this.client.twitterClient.isLoggedIn()) {
                return true;
            }

            elizaLogger.info("MovebotService: Attempting to refresh login");
            
            // Try to use cached cookies first
            const username = this.client.twitterConfig.TWITTER_USERNAME;
            const cachedCookies = await this.client.getCachedCookies(username);
            
            if (cachedCookies) {
                await this.client.setCookiesFromArray(cachedCookies);
                if (await this.client.twitterClient.isLoggedIn()) {
                    elizaLogger.info("MovebotService: Successfully logged in with cached cookies");
                    return true;
                }
            }

            // If cached cookies didn't work, do a fresh login
            const password = this.client.twitterConfig.TWITTER_PASSWORD;
            const email = this.client.twitterConfig.TWITTER_EMAIL;
            const twitter2faSecret = this.client.twitterConfig.TWITTER_2FA_SECRET;

            await this.client.twitterClient.login(username, password, email, twitter2faSecret);
            
            if (await this.client.twitterClient.isLoggedIn()) {
                elizaLogger.info("MovebotService: Successfully logged in with fresh credentials");
                // Cache the new cookies
                await this.client.cacheCookies(username, await this.client.twitterClient.getCookies());
                return true;
            }

            elizaLogger.error("MovebotService: Failed to login after all attempts");
            return false;
        } catch (error) {
            elizaLogger.error("MovebotService: Error during login:", {
                error: error.message,
                stack: error.stack
            });
            return false;
        }
    }

    public override async handleTweet({
        tweet,
        message,
        thread,
    }: {
        tweet: Tweet;
        message: Memory;
        thread: Tweet[];
    }): Promise<{ text: string; action: string }> {
        try {
            if (!tweet?.text) {
                elizaLogger.warn("Invalid tweet received:", tweet);
                return { text: "", action: "IGNORE" };
            }

            // First try to process with Movebot plugin
            const result = await this.safeApiCall(async () => 
                this.movebotPlugin.processSingleTweet(tweet, thread)
            );
            
            if (result) {
                elizaLogger.info("MovebotService: Plugin processing result:", result);
                
                // Send the response back to the user
                if (result.response) {
                    await this.safeApiCall(async () => {
                        await sendTweet(
                            this.client,
                            { text: result.response },
                            message.roomId,
                            this.client.twitterConfig.TWITTER_USERNAME,
                            tweet.id
                        );
                    });
                }

                return {
                    text: result.response || "",
                    action: result.action || "RESPOND"
                };
            }

            // If no Movebot-specific action was taken, fall back to parent class handling
            return super.handleTweet({ tweet, message, thread });
        } catch (error) {
            elizaLogger.error("Error in MovebotService handleTweet:", error);
            return {
                text: "I encountered an error processing your request. Could you try again?",
                action: "ERROR"
            };
        }
    }

    public registerKeywordAction(
        name: string,
        description: string,
        examples: string[],
        action: (tweet: Tweet, runtime: IAgentRuntime, params?: Map<string, string>) => Promise<{
            response: string;
            data?: any;
            action?: string;
        }>
    ) {
        this.movebotPlugin.registerKeywordAction({
            name,
            description,
            examples,
            action
        });
    }
} 