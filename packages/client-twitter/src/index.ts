import { type Client, elizaLogger, type IAgentRuntime } from "@elizaos/core";
import { ClientBase } from "./base.ts";
import { validateTwitterConfig, type TwitterConfig } from "./environment.ts";
import { TwitterInteractionClient } from "./interactions.ts";
import { TwitterPostClient } from "./post.ts";
import { TwitterSearchClient } from "./search.ts";
import { TwitterSpaceClient } from "./spaces.ts";
import { TwitterKeywordService } from "./plugins/TwitterKeywordService";

/**
 * A manager that orchestrates all specialized Twitter logic:
 * - client: base operations (login, timeline caching, etc.)
 * - post: autonomous posting logic
 * - search: searching tweets / replying logic
 * - interaction: handling mentions, replies
 * - space: launching and managing Twitter Spaces (optional)
 * - keywordService: handling keyword-based interactions (optional)
 */
class TwitterManager implements Client {
    client: ClientBase;
    post: TwitterPostClient;
    search: TwitterSearchClient;
    interaction: TwitterInteractionClient;
    space?: TwitterSpaceClient;
    keywordService?: TwitterKeywordService;

    constructor(runtime: IAgentRuntime, twitterConfig: TwitterConfig) {
        // Pass twitterConfig to the base client
        this.client = new ClientBase(runtime, twitterConfig);

        // Posting logic
        this.post = new TwitterPostClient(this.client, runtime);

        // Optional search logic (enabled if TWITTER_SEARCH_ENABLE is true)
        if (twitterConfig.TWITTER_SEARCH_ENABLE) {
            elizaLogger.warn("Twitter/X client running in a mode that:");
            elizaLogger.warn("1. violates consent of random users");
            elizaLogger.warn("2. burns your rate limit");
            elizaLogger.warn("3. can get your account banned");
            elizaLogger.warn("use at your own risk");
            this.search = new TwitterSearchClient(this.client, runtime);
        }

        // Mentions and interactions
        this.interaction = new TwitterInteractionClient(this.client, runtime);

        // Optional Spaces logic (enabled if TWITTER_SPACES_ENABLE is true)
        if (twitterConfig.TWITTER_SPACES_ENABLE) {
            this.space = new TwitterSpaceClient(this.client, runtime);
        }

        // Optional keyword service (enabled if TWITTER_KEYWORD_SERVICE_ENABLE is true)
        if (twitterConfig.TWITTER_KEYWORD_SERVICE_ENABLE) {
            elizaLogger.log("Initializing Twitter keyword service");
            this.keywordService = new TwitterKeywordService(this.client, runtime);
        }
    }

    async start() {
        // // Start the post client
        // await this.post.start();

        // // Start the search client if enabled
        // if (this.search) {
        //     await this.search.start();
        // }

        // // Start the interaction client
        // await this.interaction.start();

        // // Start the space client if enabled
        // if (this.space) {
        //     await this.space.startPeriodicSpaceCheck();
        // }

        // Start the keyword service if enabled
        if (this.keywordService) {
            await this.keywordService.start();
        }
    }

    async stop() {
        // Stop the space client if enabled
        if (this.space) {
            this.space.stopPeriodicCheck();
        }

        elizaLogger.log("Twitter client stopped");
    }
}

export async function createTwitterClient(
    runtime: IAgentRuntime
): Promise<Client> {
    const twitterConfig = await validateTwitterConfig(runtime);
    const manager = new TwitterManager(runtime, twitterConfig);
    await manager.start();
    return manager;
}

export * from "./environment.ts";
export * from "./plugins/KeywordActionPlugin";
export * from "./plugins/TwitterKeywordService";
