import { Action, IAgentRuntime, Memory, State, elizaLogger, composeContext, generateText, ModelClass, stringToUuid, ModelProviderName, models } from "@elizaos/core";
import { Scraper } from "agent-twitter-client";
import { EventStateService } from "../services/event-state";

export const replyAction: Action = {
    name: "TWEET_REPLY",
    similes: ["REPLY_TWEET", "RESPOND_TWEET"],
    description: "Reply to a tweet based on blockchain event",
    examples: [
        [
            {
                user: "user",
                content: {
                    text: "Reply to tweet https://twitter.com/user/status/123456789",
                    action: "TWEET_REPLY"
                }
            }
        ] 
    ],
    validate: async (runtime: IAgentRuntime, message: Memory, state?: State) => {
        const username = runtime.getSetting("TWITTER_USERNAME");
        const password = runtime.getSetting("TWITTER_PASSWORD");
        const email = runtime.getSetting("TWITTER_EMAIL");
        return !!username && !!password && !!email;
    },

    handler: async (runtime: IAgentRuntime, message: Memory, state?: State): Promise<boolean> => {
        const eventStateService = new EventStateService();
        await eventStateService.initialize(runtime);
        
        const content = message.content as unknown as { 
            tweet_link: string; 
            user: string;
            template: string;
        };

        // Use the same roomId format as block-processor
        const roomId = message.roomId.includes('-') ? 
            message.roomId : 
            stringToUuid(message.roomId);
        
        try {
            // Check if already completed
            if (await eventStateService.isEventCompleted(roomId)) {
                elizaLogger.info("Event already completed", { 
                    roomId,
                    tweetId: await eventStateService.getEventTweetId(roomId)
                });
                return true;
            }

            // Initialize Twitter client
            const scraper = new Scraper();
            const username = runtime.getSetting("TWITTER_USERNAME");
            const password = runtime.getSetting("TWITTER_PASSWORD");
            const email = runtime.getSetting("TWITTER_EMAIL");
            const twitter2faSecret = runtime.getSetting("TWITTER_2FA_SECRET");

            // Log credential presence (not values)
            elizaLogger.debug("Twitter credentials check", {
                roomId,
                hasUsername: !!username,
                hasPassword: !!password,
                hasEmail: !!email,
                has2FA: !!twitter2faSecret,
                usernameLength: username?.length,
                emailMask: email ? `${email[0]}***${email.split('@')[1]}` : undefined
            });

            // Login to Twitter with detailed logging
            elizaLogger.debug("Starting Twitter login attempt", { 
                roomId,
                timestamp: new Date().toISOString()
            });

            try {
                await scraper.login(username, password, email, twitter2faSecret);

                elizaLogger.debug("Login request completed", {
                    roomId,
                    timestamp: new Date().toISOString()
                });

                const loginCheck = await Promise.race([
                    scraper.isLoggedIn(),
                    new Promise<boolean>((_, reject) => 
                        setTimeout(() => reject(new Error("Login check timeout")), 5000)
                    )
                ]);

                if (!loginCheck) {
                    throw new Error("Login check failed after authentication attempt");
                }

                elizaLogger.info("Twitter login successful", {
                    roomId,
                    username: username ? `${username.substring(0, 2)}***` : undefined
                });
            } catch (loginError) {
                const errorMessage = loginError instanceof Error ? loginError.message : String(loginError);
                
                // Parse error details if possible
                let errorDetails = {};
                try {
                    if (typeof errorMessage === 'string' && errorMessage.includes('{')) {
                        const parsedError = JSON.parse(errorMessage);
                        errorDetails = {
                            errorCode: parsedError.errors?.[0]?.code,
                            errorMessage: parsedError.errors?.[0]?.message
                        };
                    }
                } catch (parseError) {
                    errorDetails = { rawError: errorMessage };
                }

                elizaLogger.error("Twitter login failed", {
                    roomId,
                    ...errorDetails,
                    errorType: loginError?.constructor?.name,
                    timestamp: new Date().toISOString()
                });
                
                throw new Error(`Twitter authentication failed: ${errorMessage}`);
            }

            const tweetId = extractTweetId(content.tweet_link);
            elizaLogger.debug("Extracted tweet ID", {
                roomId,
                tweetId,
                originalLink: content.tweet_link
            });
            
            // Get tweet data with detailed logging
            let tweetData;
            try {
                elizaLogger.debug("Fetching tweet data", { roomId, tweetId });
                tweetData = await scraper.getTweet(tweetId);
                elizaLogger.debug("Tweet data fetched", {
                    roomId,
                    tweetId,
                    hasText: !!tweetData?.text,
                    textLength: tweetData?.text?.length,
                    replyCount: tweetData?.replies?.length
                });
            } catch (tweetError) {
                elizaLogger.error("Failed to fetch tweet", {
                    roomId,
                    tweetId,
                    error: tweetError instanceof Error ? tweetError.message : String(tweetError)
                });
                throw tweetError;
            }

            // Check if we've already replied to this tweet
            if (Array.isArray(tweetData.replies) && tweetData.replies.some(reply => reply.username === username)) {
                elizaLogger.info("Already replied to this tweet", { roomId, tweetId });
                await eventStateService.markEventComplete(roomId, tweetId);
                return true;
            }

            // Generate and send response
            const response = await generateResponse({
                template: content.template,
                user: content.user,
                tweet_text: tweetData.text,
                runtime
            });

            elizaLogger.debug("Generated response", {
                roomId,
                tweetId,
                originalTweet: tweetData.text,
                response
            });

            // Validate tweet before sending
            if (!tweetId) {
                const error = "Invalid tweet ID";
                elizaLogger.error("Tweet validation failed", { roomId, error });
                await eventStateService.markEventFailed(roomId, error);
                return false;
            }

            if (response.length > 280) {
                const error = `Tweet too long: ${response.length} characters`;
                elizaLogger.error("Tweet validation failed", { roomId, error, response });
                await eventStateService.markEventFailed(roomId, error);
                return false;
            }

            elizaLogger.debug("Attempting to send tweet reply", {
                roomId,
                tweetId,
                responseLength: response.length,
                response
            });

            try {
                await scraper.sendTweet(response, tweetId);
            } catch (error) {
                const errorMessage = error instanceof Error ? error.message : String(error);
                elizaLogger.error("Tweet send failed", {
                    roomId,
                    tweetId,
                    responseLength: response.length,
                    error: errorMessage,
                    response
                });
                await eventStateService.markEventFailed(roomId, errorMessage);
                return false;
            }
            
            // Mark event as completed with roomId
            await eventStateService.markEventComplete(roomId, tweetId);

            elizaLogger.info("Tweet reply sent successfully", {
                roomId,
                tweetId,
                response
            });

            return true;
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            
            // Enhanced error logging
            let errorDetails = {};
            try {
                if (typeof errorMessage === 'string' && errorMessage.includes('{')) {
                    const parsedError = JSON.parse(errorMessage);
                    errorDetails = {
                        errorCode: parsedError.errors?.[0]?.code,
                        errorMessage: parsedError.errors?.[0]?.message,
                        errorTimestamp: new Date().toISOString()
                    };
                }
            } catch (parseError) {
                errorDetails = { 
                    rawError: errorMessage,
                    parseErrorMessage: parseError instanceof Error ? parseError.message : String(parseError)
                };
            }

            elizaLogger.error("Tweet reply failed", {
                roomId,
                ...errorDetails,
                errorType: error?.constructor?.name,
                stack: error instanceof Error ? error.stack : undefined
            });
            
            await eventStateService.markEventFailed(roomId, errorMessage);
            return false;
        }
    }
};

async function updateMemoryStatus(
    runtime: IAgentRuntime, 
    message: Memory, 
    status: 'PENDING' | 'IN_PROGRESS' | 'COMPLETED' | 'FAILED',
    statusMessage?: string,
    processed: boolean = false
): Promise<Memory> {
    // Simple state update with minimal fields
    const updatedMemory: Memory = {
        ...message,
        content: {
            ...message.content,
            status,
            processed: status === 'COMPLETED',
            statusMessage: statusMessage || message.content.statusMessage
        }
    };

    // Single attempt to update
    await runtime.messageManager.createMemory(updatedMemory);
    return updatedMemory;
}

function extractTweetId(tweetLink: string): string {
    if (!tweetLink) {
        elizaLogger.error("Empty tweet link provided");
        return '';
    }

    try {
        // Handle full URLs
        if (tweetLink.startsWith('http')) {
            const url = new URL(tweetLink);
            const matches = url.pathname.match(/\/status\/(\d+)/);
            if (matches?.[1]) {
                return matches[1];
            }
        }
        
        // Handle just the ID - if it's all digits
        if (/^\d+$/.test(tweetLink)) {
            return tweetLink;
        }
        
        // Handle status/ID format
        const statusMatches = tweetLink.match(/\/status\/(\d+)/);
        if (statusMatches?.[1]) {
            return statusMatches[1];
        }

        // Try to extract numeric ID from any string
        const numericId = tweetLink.match(/(\d{10,})/);
        if (numericId?.[1]) {
            return numericId[1];
        }

        elizaLogger.error("Could not extract tweet ID from link", { tweetLink });
        return '';
    } catch (error) {
        elizaLogger.error("Error extracting tweet ID", { 
            tweetLink, 
            error: error instanceof Error ? error.message : String(error) 
        });
        return '';
    }
}

interface ResponseParams {
    template: string;
    user: string;
    tweet_text: string;
    runtime: IAgentRuntime;
}

async function generateResponse({ template, user, tweet_text, runtime }: ResponseParams): Promise<string> {
    // Array of model providers to try in order
    const modelProviders = [
        runtime.character?.modelProvider || ModelProviderName.OPENAI,
        ModelProviderName.ANTHROPIC,
        ModelProviderName.OPENAI
    ].filter((value, index, self) => self.indexOf(value) === index); // Remove duplicates

    let lastError: Error | null = null;

    // Try each model provider in sequence
    for (const provider of modelProviders) {
        try {
            const model = models[provider];
            
            elizaLogger.debug("Attempting with model provider", {
                provider,
                modelClass: model?.modelClass || ModelClass.MEDIUM,
                hasModel: !!model
            });

            const state = await runtime.composeState({
                userId: runtime.agentId,
                roomId: stringToUuid(`tweet-reply-${Date.now()}`),
                agentId: runtime.agentId,
                content: {
                    text: tweet_text,
                    action: "TWEET_REPLY"
                }
            });

            const context = composeContext({
                state,
                template: `
# Character Knowledge Base
${runtime.character.knowledge}

# About ${runtime.character.name}:
${runtime.character.bio}
${runtime.character.lore}

# Areas of Expertise:
${runtime.character.topics.join(", ")}

# Task: Generate a tweet reply as ${runtime.character.name}
Original tweet from @${user}: ${tweet_text}

Instructions:
1. Use the character's knowledge to inform the response
2. Keep the tone consistent with ${runtime.character.name}'s personality
3. Be concise and engaging (1-2 sentences)
4. Follow this template: ${template}
5. Ensure the response is relevant to the original tweet content
6. Do not mention missing content or inability to respond`
            });

            const response = await generateText({
                runtime,
                context,
                modelClass: model?.modelClass || ModelClass.SMALL,
                
            });

            // Clean up and validate response
            const cleanedResponse = response.replace(/^(@[\w\d_]+\s*)+/, '').trim();
            
            if (cleanedResponse.toLowerCase().includes("don't have") || 
                cleanedResponse.toLowerCase().includes("cannot generate") ||
                cleanedResponse.toLowerCase().includes("missing content")) {
                throw new Error("AI generated invalid response about missing content");
            }

            // Handle length limit
            if (cleanedResponse.length > 280) {
                const truncated = cleanedResponse.substring(0, 277);
                const lastSentence = truncated.match(/^.*[.!?](?:\s|$)/);
                return lastSentence ? lastSentence[0].trim() : truncated + '...';
            }

            elizaLogger.info("Successfully generated response", {
                provider,
                responseLength: cleanedResponse.length
            });

            return cleanedResponse;

        } catch (error) {
            lastError = error instanceof Error ? error : new Error(String(error));
            elizaLogger.warn(`Failed to generate with ${provider}`, {
                provider,
                error: lastError.message,
                errorType: error?.constructor?.name,
                willTryNext: modelProviders.indexOf(provider) < modelProviders.length - 1
            });
        }
    }

    // If we get here, all providers failed
    elizaLogger.error("All model providers failed to generate response", {
        triedProviders: modelProviders,
        finalError: lastError?.message
    });
    throw lastError || new Error("Failed to generate response with all available providers");
} 