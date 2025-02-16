import { SearchMode, type Tweet } from "agent-twitter-client";
import {
    composeContext,
    generateMessageResponse,
    generateShouldRespond,
    messageCompletionFooter,
    shouldRespondFooter,
    type Content,
    type HandlerCallback,
    type IAgentRuntime,
    type Memory,
    ModelClass,
    type State,
    stringToUuid,
    elizaLogger,
    getEmbeddingZeroVector,
    type IImageDescriptionService,
    ServiceType
} from "@elizaos/core";
import type { ClientBase } from "./base";
import { buildConversationThread, sendTweet, wait } from "./utils.ts";

export const twitterMessageHandlerTemplate =
    `
# Areas of Expertise
{{knowledge}}

# About {{agentName}} (@{{twitterUserName}}):
{{bio}}
{{lore}}
{{topics}}

{{providers}}

{{characterPostExamples}}

{{postDirections}}

Recent interactions between {{agentName}} and other users:
{{recentPostInteractions}}

{{recentPosts}}

# TASK: Generate a post/reply in the voice, style and perspective of {{agentName}} (@{{twitterUserName}}) while using the thread of tweets as additional context:

Current Post:
{{currentPost}}
Here is the descriptions of images in the Current post.
{{imageDescriptions}}

Thread of Tweets You Are Replying To:
{{formattedConversation}}

# INSTRUCTIONS: Generate a post in the voice, style and perspective of {{agentName}} (@{{twitterUserName}}). You MUST include an action if the current post text includes a prompt that is similar to one of the available actions mentioned here:
{{actionNames}}
{{actions}}

Here is the current post text again. Remember to include an action if the current post text includes a prompt that asks for one of the available actions mentioned above (does not need to be exact)
{{currentPost}}
Here is the descriptions of images in the Current post.
{{imageDescriptions}}
` + messageCompletionFooter;

export const twitterShouldRespondTemplate = (targetUsersStr: string) =>
    `# INSTRUCTIONS: Determine if {{agentName}} (@{{twitterUserName}}) should respond to the message and participate in the conversation. Do not comment. Just respond with "true" or "false".

Response options are RESPOND, IGNORE and STOP.

PRIORITY RULE: ALWAYS RESPOND to these users regardless of topic or message content: ${targetUsersStr}. Topic relevance should be ignored for these users.

For other users:
- {{agentName}} should RESPOND to messages directed at them
- {{agentName}} should RESPOND to conversations relevant to their background
- {{agentName}} should IGNORE irrelevant messages
- {{agentName}} should IGNORE very short messages unless directly addressed
- {{agentName}} should STOP if asked to stop
- {{agentName}} should STOP if conversation is concluded
- {{agentName}} is in a room with other users and wants to be conversational, but not annoying.

IMPORTANT:
- {{agentName}} (aka @{{twitterUserName}}) is particularly sensitive about being annoying, so if there is any doubt, it is better to IGNORE than to RESPOND.
- For users not in the priority list, {{agentName}} (@{{twitterUserName}}) should err on the side of IGNORE rather than RESPOND if in doubt.

Recent Posts:
{{recentPosts}}

Current Post:
{{currentPost}}

Thread of Tweets You Are Replying To:
{{formattedConversation}}

# INSTRUCTIONS: Respond with [RESPOND] if {{agentName}} should respond, or [IGNORE] if {{agentName}} should not respond to the last message and [STOP] if {{agentName}} should stop participating in the conversation.
` + shouldRespondFooter;

export class TwitterInteractionClient {
    client: ClientBase;
    runtime: IAgentRuntime;
    private isDryRun: boolean;
    private static isProcessing: boolean = false;
    protected static isLoggedIn: boolean = false;
    protected static readonly PROCESSING_INTERVAL = 600; // 1 minute
    protected static readonly TIMEOUT = 6000000; // 60 seconds

    constructor(client: ClientBase, runtime: IAgentRuntime) {
        this.client = client;
        this.runtime = runtime;
        this.isDryRun = this.client.twitterConfig.TWITTER_DRY_RUN;
    }

    protected async ensureLogin(): Promise<boolean> {
        if (TwitterInteractionClient.isLoggedIn) {
            return true;
        }

        try {
            // First try using cached cookies
            const username = this.client.twitterConfig.TWITTER_USERNAME;
            const cachedCookies = await this.client.getCachedCookies(username);
            
            if (cachedCookies) {
                elizaLogger.info("Attempting to use cached cookies");
                await this.client.setCookiesFromArray(cachedCookies);
                if (await this.client.twitterClient.isLoggedIn()) {
                    elizaLogger.info("Successfully logged in with cached cookies");
                    TwitterInteractionClient.isLoggedIn = true;
                    return true;
                }
            }

            // If cached cookies didn't work, do a fresh login
            elizaLogger.info("Performing fresh login");
            const password = this.client.twitterConfig.TWITTER_PASSWORD;
            const email = this.client.twitterConfig.TWITTER_EMAIL;
            const twitter2faSecret = this.client.twitterConfig.TWITTER_2FA_SECRET;

            await this.client.twitterClient.login(username, password, email, twitter2faSecret);
            
            if (await this.client.twitterClient.isLoggedIn()) {
                elizaLogger.info("Successfully logged in to Twitter");
                await this.client.cacheCookies(username, await this.client.twitterClient.getCookies());
                TwitterInteractionClient.isLoggedIn = true;
                return true;
            }

            elizaLogger.error("Failed to login to Twitter");
            return false;
        } catch (error) {
            elizaLogger.error("Error during Twitter login:", error);
            TwitterInteractionClient.isLoggedIn = false;
            return false;
        }
    }

    protected async safeApiCall<T>(operation: () => Promise<T>): Promise<T | null> {
        try {
            const timeoutPromise = new Promise((_, reject) => {
                setTimeout(() => reject(new Error('Operation timeout')), TwitterInteractionClient.TIMEOUT);
            });

            return await Promise.race([operation(), timeoutPromise]) as T;
        } catch (error) {
            if (error.message?.includes('401') || error.message?.includes('403')) {
                elizaLogger.error("Authentication error, will need to re-login:", error);
                // Try to re-login immediately
                TwitterInteractionClient.isLoggedIn = false;
                if (await this.ensureLogin()) {
                    // Retry the operation once after successful re-login
                    return operation();
                }
            } else {
                elizaLogger.error("API call error:", error);
            }
            return null;
        }
    }

    async start() {
        if (!await this.ensureLogin()) {
            elizaLogger.error("Failed to initialize TwitterInteractionClient, retrying in 30 seconds");
            setTimeout(() => this.start(), 3000);
            return;
        }

        const handleTwitterInteractionsLoop = async () => {
            if (TwitterInteractionClient.isProcessing) {
                elizaLogger.debug("Tweet processing already in progress, skipping");
                return;
            }

            TwitterInteractionClient.isProcessing = true;
            try {
                elizaLogger.info("Fetching timeline for interactions...");
                const timeline = await this.safeApiCall(() => 
                    this.client.fetchTimelineForActions(100)
                );
                
                if (!timeline || timeline.length === 0) {
                    elizaLogger.debug("No tweets found in timeline");
                    return;
                }

                for (const tweet of timeline) {
                    try {
                        // Validate tweet object
                        if (!tweet || !tweet.userId || !tweet.id) {
                            elizaLogger.warn("Invalid tweet object:", tweet);
                            continue;
                        }

                        const memoryId = stringToUuid(tweet.id + "-" + this.runtime.agentId);
                        const existingMemory = await this.runtime.messageManager.getMemoryById(memoryId);
                        if (existingMemory) {
                            elizaLogger.debug("Tweet already processed, skipping:", tweet.id);
                            continue;
                        }

                        const userId = stringToUuid(tweet.userId);
                        const roomId = stringToUuid(tweet.id + "-" + this.runtime.agentId);

                        await this.runtime.ensureConnection(
                            userId,
                            roomId,
                            tweet.username || "unknown_user",
                            tweet.name || "Unknown User",
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

                        const memory = {
                            id: memoryId,
                            userId,
                            content,
                            agentId: this.runtime.agentId,
                            roomId,
                            embedding: getEmbeddingZeroVector(),
                            createdAt: tweet.timestamp ? tweet.timestamp * 1000 : Date.now(),
                        };

                        await this.runtime.messageManager.createMemory(memory);

                        const thread = await this.safeApiCall(() => 
                            buildConversationThread(tweet, this.client)
                        ) || [];
                        
                        await this.handleTweet({
                            tweet,
                            message: memory,
                            thread,
                        });
                    } catch (tweetError) {
                        elizaLogger.error("Error processing individual tweet:", tweetError);
                        continue;
                    }
                }

                elizaLogger.info("Finished processing Twitter interactions");
            } catch (error) {
                elizaLogger.error("Error in handleTwitterInteractions:", error);
            } finally {
                TwitterInteractionClient.isProcessing = false;
            }
        };

        // Initial processing
        await handleTwitterInteractionsLoop();

        // Set up interval for subsequent processing
        setInterval(handleTwitterInteractionsLoop, TwitterInteractionClient.PROCESSING_INTERVAL);
    }

    public async handleTweet({
        tweet,
        message,
        thread,
    }: {
        tweet: Tweet;
        message: Memory;
        thread: Tweet[];
    }) {
        // Only skip if tweet is from self AND not from a target user
        if (tweet.userId === this.client.profile.id &&
            !this.client.twitterConfig.TWITTER_TARGET_USERS.includes(tweet.username)) {
            return;
        }

        if (!message.content.text) {
            elizaLogger.log("Skipping Tweet with no text", tweet.id);
            return { text: "", action: "IGNORE" };
        }

        elizaLogger.log("Processing Tweet: ", tweet.id);
        const formatTweet = (tweet: Tweet) => {
            return `  ID: ${tweet.id}
  From: ${tweet.name} (@${tweet.username})
  Text: ${tweet.text}`;
        };
        const currentPost = formatTweet(tweet);

        const formattedConversation = thread
            .map(
                (tweet) => `@${tweet.username} (${new Date(
                    tweet.timestamp * 1000
                ).toLocaleString("en-US", {
                    hour: "2-digit",
                    minute: "2-digit",
                    month: "short",
                    day: "numeric",
                })}):
        ${tweet.text}`
            )
            .join("\n\n");

        const imageDescriptionsArray = [];
        try{
            for (const photo of tweet.photos) {
                const description = await this.runtime
                    .getService<IImageDescriptionService>(
                        ServiceType.IMAGE_DESCRIPTION
                    )
                    .describeImage(photo.url);
                imageDescriptionsArray.push(description);
            }
        } catch (error) {
    // Handle the error
    elizaLogger.error("Error Occured during describing image: ", error);
}




        let state = await this.runtime.composeState(message, {
            twitterClient: this.client.twitterClient,
            twitterUserName: this.client.twitterConfig.TWITTER_USERNAME,
            currentPost,
            formattedConversation,
            imageDescriptions: imageDescriptionsArray.length > 0
            ? `\nImages in Tweet:\n${imageDescriptionsArray.map((desc, i) =>
              `Image ${i + 1}: Title: ${desc.title}\nDescription: ${desc.description}`).join("\n\n")}`:""
        });

        // check if the tweet exists, save if it doesn't
        const tweetId = stringToUuid(tweet.id + "-" + this.runtime.agentId);
        const tweetExists =
            await this.runtime.messageManager.getMemoryById(tweetId);

        if (!tweetExists) {
            elizaLogger.log("tweet does not exist, saving");
            const userIdUUID = stringToUuid(tweet.userId as string);
            const roomId = stringToUuid(tweet.conversationId);

            const message = {
                id: tweetId,
                agentId: this.runtime.agentId,
                content: {
                    text: tweet.text,
                    url: tweet.permanentUrl,
                    imageUrls: tweet.photos?.map(photo => photo.url) || [],
                    inReplyTo: tweet.inReplyToStatusId
                        ? stringToUuid(
                              tweet.inReplyToStatusId +
                                  "-" +
                                  this.runtime.agentId
                          )
                        : undefined,
                },
                userId: userIdUUID,
                roomId,
                createdAt: tweet.timestamp * 1000,
            };
            this.client.saveRequestMessage(message, state);
        }

        // get usernames into str
        const validTargetUsersStr =
            this.client.twitterConfig.TWITTER_TARGET_USERS.join(",");

        const shouldRespondContext = composeContext({
            state,
            template:
                this.runtime.character.templates
                    ?.twitterShouldRespondTemplate ||
                this.runtime.character?.templates?.shouldRespondTemplate ||
                twitterShouldRespondTemplate(validTargetUsersStr),
        });

        const shouldRespond = await generateShouldRespond({
            runtime: this.runtime,
            context: shouldRespondContext,
            modelClass: ModelClass.MEDIUM,
        });

        // Promise<"RESPOND" | "IGNORE" | "STOP" | null> {
        if (shouldRespond !== "RESPOND") {
            elizaLogger.log("Not responding to message");
            return { text: "Response Decision:", action: shouldRespond };
        }

        const context = composeContext({
            state: {
                ...state,
                // Convert actionNames array to string
                actionNames: Array.isArray(state.actionNames)
                    ? state.actionNames.join(', ')
                    : state.actionNames || '',
                actions: Array.isArray(state.actions)
                    ? state.actions.join('\n')
                    : state.actions || '',
                // Ensure character examples are included
                characterPostExamples: this.runtime.character.messageExamples
                    ? this.runtime.character.messageExamples
                        .map(example =>
                            example.map(msg =>
                                `${msg.user}: ${msg.content.text}${msg.content.action ? ` [Action: ${msg.content.action}]` : ''}`
                            ).join('\n')
                        ).join('\n\n')
                    : '',
            },
            template:
                this.runtime.character.templates
                    ?.twitterMessageHandlerTemplate ||
                this.runtime.character?.templates?.messageHandlerTemplate ||
                twitterMessageHandlerTemplate,
        });

        const response = await generateMessageResponse({
            runtime: this.runtime,
            context,
            modelClass: ModelClass.LARGE,
        });

        const removeQuotes = (str: string) =>
            str.replace(/^['"](.*)['"]$/, "$1");

        const stringId = stringToUuid(tweet.id + "-" + this.runtime.agentId);

        response.inReplyTo = stringId;

        response.text = removeQuotes(response.text);

        if (response.text) {
            if (this.isDryRun) {
                elizaLogger.info(
                    `Dry run: Selected Post: ${tweet.id} - ${tweet.username}: ${tweet.text}\nAgent's Output:\n${response.text}`
                );
            } else {
                try {
                    const callback: HandlerCallback = async (
                        response: Content,
                        tweetId?: string
                    ) => {
                        const memories = await sendTweet(
                            this.client,
                            response,
                            message.roomId,
                            this.client.twitterConfig.TWITTER_USERNAME,
                            tweetId || tweet.id
                        );
                        return memories;
                    };

                    const responseMessages = await callback(response);

                    state = (await this.runtime.updateRecentMessageState(
                        state
                    )) as State;

                    for (const responseMessage of responseMessages) {
                        if (
                            responseMessage ===
                            responseMessages[responseMessages.length - 1]
                        ) {
                            responseMessage.content.action = response.action;
                        } else {
                            responseMessage.content.action = "CONTINUE";
                        }
                        await this.runtime.messageManager.createMemory(
                            responseMessage
                        );
                    }
                    const responseTweetId =
                    responseMessages[responseMessages.length - 1]?.content
                        ?.tweetId;
                    await this.runtime.processActions(
                        message,
                        responseMessages,
                        state,
                        (response: Content) => {
                            return callback(response, responseTweetId);
                        }
                    );

                    const responseInfo = `Context:\n\n${context}\n\nSelected Post: ${tweet.id} - ${tweet.username}: ${tweet.text}\nAgent's Output:\n${response.text}`;

                    await this.runtime.cacheManager.set(
                        `twitter/tweet_generation_${tweet.id}.txt`,
                        responseInfo
                    );
                    await wait();
                } catch (error) {
                    elizaLogger.error(`Error sending response tweet: ${error}`);
                }
            }
        }
    }

    
}