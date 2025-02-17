import { type Tweet } from "agent-twitter-client";
import { 
    type IAgentRuntime,
    elizaLogger,
} from "@elizaos/core";
import { ClientBase } from "../base";
import { type IKeywordPlugin, type IKeywordAction } from "./KeywordActionPlugin";
import { TweetImageUploader } from "./utils/PostCreator";
import { Aptos, AptosConfig, Network, Account, Ed25519PrivateKey, PrivateKey, PrivateKeyVariants } from "@aptos-labs/ts-sdk";
import { MOVEMENT_NETWORK_CONFIG, DEFAULT_NETWORK, MOVEMENT_EXPLORER_URL } from "../constants";
import { fetchTwitterUser } from "./utils/fetchTwitterUser";

// Error codes from smart contract
const ERROR_CODES = {
    COLLECTION_NOT_FOUND: '0x66002',
    NFT_NOT_FOUND: '0x66003',
    NFT_NOT_TRANSFERRABLE: '0x56004',
    NFT_NOT_OWNER: '0x56005',
    NFT_LIMIT_EXHAUSTED: '0x66001',
    USER_NOT_REGISTERED: '0x51001'
} as const;

// Error messages for user feedback
const ERROR_MESSAGES = {
    [ERROR_CODES.COLLECTION_NOT_FOUND]: "You don't have an NFT collection yet. Create an NFT first to start your collection.",
    [ERROR_CODES.NFT_NOT_FOUND]: "The specified NFT was not found in your collection.",
    [ERROR_CODES.NFT_NOT_TRANSFERRABLE]: "This NFT is soul-bound and cannot be transferred.",
    [ERROR_CODES.NFT_NOT_OWNER]: "You are not the owner of this NFT.",
    [ERROR_CODES.NFT_LIMIT_EXHAUSTED]: "You've reached the maximum limit of NFTs (1000) in your collection.",
    [ERROR_CODES.USER_NOT_REGISTERED]: "You don't have a wallet registered yet. Please create one first.",
    GENERIC_ERROR: "An error occurred while processing your request. Please try again.",
    PROFILE_FETCH_ERROR: "Could not fetch your profile information. Please try again.",
    WALLET_RESOLVE_ERROR: "Could not find a wallet address for the specified user. Please provide a valid username or wallet address.",
    IMAGE_GENERATION_ERROR: "Failed to generate NFT image from your tweet.",
} as const;

export interface NFTCreationParams {
    username: string;      // Twitter handle of the creator
    tweetId: string;      // ID of the tweet
    profileUri: string;    // User's profile URI (not profile image)
    imageUri: string;      // Generated image URI for the NFT
    recipient?: string;    // Optional recipient address for soul-bound NFTs
    nftName?: string;     // NFT name for transfer operations
    isSelfSoulBound?: boolean; // Whether to create soul-bound NFT for self
}

export class NFTPlugin implements IKeywordPlugin {
    readonly name = "nft-creation";
    readonly description = "Plugin for creating and managing NFTs";
    
    private client: ClientBase;
    private runtime: IAgentRuntime;
    private registeredActions: IKeywordAction[] = [];
    private tweetImageUploader: TweetImageUploader;

    async initialize(client: ClientBase, runtime: IAgentRuntime): Promise<void> {
        this.client = client;
        this.runtime = runtime;
        this.tweetImageUploader = new TweetImageUploader();
        this.registerActions();
        elizaLogger.info("NFTPlugin: Initialized");
    }

    public getActions(): IKeywordAction[] {
        return this.registeredActions;
    }

    public registerAction(action: IKeywordAction): void {
        this.registeredActions.push(action);
        elizaLogger.info("NFTPlugin: Registered action:", {
            name: action.name,
            description: action.description
        });
    }

    private getErrorMessage(error: any): string {
        if (error?.message) {
            // Check for specific error codes in the error message
            for (const [code, message] of Object.entries(ERROR_MESSAGES)) {
                if (error.message.includes(code)) {
                    return message;
                }
            }

            // Special handling for user not registered error
            if (error.message.includes('0x51001')) {
                return "You don't have a wallet registered yet. Please create one first.";
            }
        }
        return ERROR_MESSAGES.GENERIC_ERROR;
    }

    private async stage_execute(params: NFTCreationParams, action: string): Promise<{
        success: boolean;
        transactionId?: string;
        error?: string;
        action?: string;
    }> {
        try {
            const privateKey = this.runtime.getSetting("MOVEMENT_PRIVATE_KEY");
            if (!privateKey) {
                throw new Error("Missing MOVEMENT_PRIVATE_KEY configuration");
            }

            const network = MOVEMENT_NETWORK_CONFIG[DEFAULT_NETWORK];
            if (!network) {
                throw new Error("Missing MOVEMENT_NETWORK configuration");
            }

            const contractAddress = "0xf17f471f57b12eb5a8bd1d722b385b5f1f0606d07b553828c344fb4949fd2a9d";

            const movementAccount = Account.fromPrivateKey({
                privateKey: new Ed25519PrivateKey(
                    PrivateKey.formatPrivateKey(privateKey, PrivateKeyVariants.Ed25519)
                ),
            });

            const aptosClient = new Aptos(new AptosConfig({
                network: Network.CUSTOM,
                fullnode: network.fullnode,
            }));

            let tx;
            try {
                switch (action) {
                    case "create_nft":
                        tx = await this.createNFT(aptosClient, movementAccount, contractAddress, params);
                        break;
                    case "create_soul_bound":
                        if (!params.recipient) {
                            throw new Error("Recipient address required for soul bound NFT");
                        }
                        tx = await this.createSoulBoundNFT(aptosClient, movementAccount, contractAddress, params);
                        break;
                    case "transfer_nft":
                        if (!params.recipient) {
                            throw new Error("Recipient address required for transfer");
                        }
                        tx = await this.transferNFT(aptosClient, movementAccount, contractAddress, params);
                        break;
                    default:
                        throw new Error("Invalid action");
                }

                return {
                    success: true,
                    transactionId: tx.hash,
                    action: "NFT_ACTION_COMPLETED"
                };
            } catch (error) {
                elizaLogger.error("NFTPlugin: Smart contract error:", {
                    error: error instanceof Error ? error.message : String(error),
                    params,
                    action
                });
                
                return {
                    success: false,
                    error: this.getErrorMessage(error),
                    action: "SMART_CONTRACT_ERROR"
                };
            }
        } catch (error) {
            elizaLogger.error("NFTPlugin: Error executing NFT action:", {
                error: error instanceof Error ? error.message : String(error),
                params,
                action
            });
            
            return {
                success: false,
                error: this.getErrorMessage(error),
                action: "EXECUTION_FAILED"
            };
        }
    }

    private async createNFT(aptosClient: Aptos, account: Account, contractAddress: string, params: NFTCreationParams) {
        try {
            const tx = await aptosClient.transaction.build.simple({
                sender: account.accountAddress.toStringLong(),
                data: {
                    function: `${contractAddress}::manage_nft::create_nft`,
                    typeArguments: [],
                    functionArguments: [
                        params.username,
                        params.tweetId,
                        params.profileUri,
                        params.imageUri
                    ],
                },
            });

            const committedTx = await aptosClient.signAndSubmitTransaction({
                signer: account,
                transaction: tx,
            });

            return await aptosClient.waitForTransaction({
                transactionHash: committedTx.hash,
                options: { timeoutSecs: 30, checkSuccess: true }
            });
        } catch (error) {
            elizaLogger.error("NFTPlugin: Error in createNFT:", {
                error: error instanceof Error ? error.message : String(error),
                params
            });
            throw error;
        }
    }

    private async createSoulBoundNFT(aptosClient: Aptos, account: Account, contractAddress: string, params: NFTCreationParams) {
        try {
            const tx = await aptosClient.transaction.build.simple({
                sender: account.accountAddress.toStringLong(),
                data: {
                    function: params.isSelfSoulBound 
                        ? `${contractAddress}::manage_nft::create_soul_bound_for_self`
                        : `${contractAddress}::manage_nft::create_soul_bound`,
                    typeArguments: [],
                    functionArguments: params.isSelfSoulBound
                        ? [
                            params.username,
                            params.tweetId,
                            params.profileUri,
                            params.imageUri
                        ]
                        : [
                            params.username,
                            params.tweetId,
                            params.profileUri,
                            params.imageUri,
                            params.recipient
                        ],
                },
            });

            const committedTx = await aptosClient.signAndSubmitTransaction({
                signer: account,
                transaction: tx,
            });

            return await aptosClient.waitForTransaction({
                transactionHash: committedTx.hash,
                options: { timeoutSecs: 30, checkSuccess: true }
            });
        } catch (error) {
            elizaLogger.error("NFTPlugin: Error in createSoulBoundNFT:", {
                error: error instanceof Error ? error.message : String(error),
                params
            });
            throw error;
        }
    }

    private async transferNFT(aptosClient: Aptos, account: Account, contractAddress: string, params: NFTCreationParams) {
        try {
            const tx = await aptosClient.transaction.build.simple({
                sender: account.accountAddress.toStringLong(),
                data: {
                    function: `${contractAddress}::manage_nft::transfer_nft`,
                    typeArguments: [],
                    functionArguments: [
                        params.username,
                        params.nftName,
                        params.recipient
                    ],
                },
            });

            const committedTx = await aptosClient.signAndSubmitTransaction({
                signer: account,
                transaction: tx,
            });

            return await aptosClient.waitForTransaction({
                transactionHash: committedTx.hash,
                options: { timeoutSecs: 30, checkSuccess: true }
            });
        } catch (error) {
            elizaLogger.error("NFTPlugin: Error in transferNFT:", {
                error: error instanceof Error ? error.message : String(error),
                params
            });
            throw error;
        }
    }

    private async createUserWallet(username: string, aptosClient: Aptos, movementAccount: Account, contractAddress: string): Promise<boolean> {
        try {
            const createUserTx = await aptosClient.transaction.build.simple({
                sender: movementAccount.accountAddress.toStringLong(),
                data: {
                    function: `${contractAddress}::user::create_user`,
                    typeArguments: [],
                    functionArguments: [username],
                },
            });

            const createUserCommitted = await aptosClient.signAndSubmitTransaction({
                signer: movementAccount,
                transaction: createUserTx,
            });

            const createUserResult = await aptosClient.waitForTransaction({
                transactionHash: createUserCommitted.hash,
                options: {
                    timeoutSecs: 30,
                    checkSuccess: true
                }
            });

            return createUserResult.success;
        } catch (error) {
            elizaLogger.error("Error creating user wallet:", error);
            throw error;
        }
    }

    private async getUserWalletAddress(username: string, aptosClient: Aptos, contractAddress: string): Promise<string | null> {
        try {
            const result = await aptosClient.view({
                payload: {
                    function: `${contractAddress}::user::get_user_address`,
                    typeArguments: [],
                    functionArguments: [username]
                }
            });
            return result[0] as string;
        } catch (error) {
            const privateKey = this.runtime.getSetting("MOVEMENT_PRIVATE_KEY");
            if (!privateKey) {
                throw new Error("Missing MOVEMENT_PRIVATE_KEY configuration");
            }
            const movementAccount = Account.fromPrivateKey({
                privateKey: new Ed25519PrivateKey(
                    PrivateKey.formatPrivateKey(
                        privateKey,
                        PrivateKeyVariants.Ed25519
                    )
                ),
            });
            const success = await this.createUserWallet(username, aptosClient, movementAccount, contractAddress);
            if(success) {
                return await this.getUserWalletAddress(username, aptosClient, contractAddress);
            }
            return success[0] as string;
        }
    }

    private getProfileUrl(username: string): string {
        return `https://x.com/${username.replace('@', '')}`;
    }

    private async getTweetIdAndImage(tweet: Tweet): Promise<{ tweetId: string| null; imageUri: string | null }> {
        // Case 1: User provided a tweet link in their message
        const tweetLinkMatch = tweet.text.match(/twitter\.com\/(\w+)\/status\/(\d+)/);
        if (tweetLinkMatch) {
            const [_, username, linkedTweetId] = tweetLinkMatch;
            const tweetUrl = `https://x.com/${username}/status/${linkedTweetId}`;
            const imageUri = await this.tweetImageUploader.uploadTweetImage(tweetUrl);
            return { tweetId: linkedTweetId, imageUri };
        }

        // Case 2: Tweet is a quote tweet
        if (tweet.quotedStatusId) {
            const replyTweet = await this.client.twitterClient.getTweet(tweet.quotedStatusId);
            const tweetUrl = replyTweet.permanentUrl
            const imageUri = await this.tweetImageUploader.uploadTweetImage(tweetUrl);
            elizaLogger.info("imageUri", imageUri)
            elizaLogger.info("tweetUrl", tweetUrl)
            return { tweetId: tweetUrl, imageUri };
        }

        // Case 3: Tweet is a reply
        if (tweet.inReplyToStatusId) {
            // For replies, we'll use the tweet URL with the original tweet ID
            // The image uploader should be able to resolve the username
            const replyTweet = await this.client.twitterClient.getTweet(tweet.inReplyToStatusId);
            const tweetUrl = replyTweet.permanentUrl
            const imageUri = await this.tweetImageUploader.uploadTweetImage(tweetUrl);
            elizaLogger.info("imageUri", imageUri)
            elizaLogger.info("tweetUrl", tweetUrl)
            return { tweetId: tweet.inReplyToStatusId, imageUri };
        }

        elizaLogger.info("can't find tweet URL, throwing error")
        throw Error("No valid tweet URL present or the tweet is not a reply, quote of another tweet. Kindly raise the tweet accordingly.")
    }

    private registerActions(): void {
        const createNFTAction: IKeywordAction = {
            name: "create_nft",
            description: "Create a new NFT from a tweet",
            examples: [
                "@gmovebot create nft from this tweet",
                "@gmovebot mint nft",
                "@gmovebot create nft from https://twitter.com/user/status/123456",
                "@gmovebot create nft from quoted tweet",
                "@gmovebot create nft from replied tweet"
            ],
            action: async (tweet: Tweet, runtime: IAgentRuntime) => {
                try {
                    // Fetch user profile information
                    const userInfo = await fetchTwitterUser(tweet.username, this.client);
                    if (!userInfo) {
                        return {
                            response: ERROR_MESSAGES.PROFILE_FETCH_ERROR,
                            action: "ERROR"
                        };
                    }

                    // Get tweet ID and image based on context
                    const { tweetId, imageUri } = await this.getTweetIdAndImage(tweet);
                    if (!imageUri) {
                        return {
                            response: ERROR_MESSAGES.IMAGE_GENERATION_ERROR,
                            action: "ERROR"
                        };
                    }

                    const params: NFTCreationParams = {
                        username: tweet.username,
                        tweetId,
                        profileUri: this.getProfileUrl(tweet.username),
                        imageUri,
                        isSelfSoulBound: false
                    };

                    const result = await this.stage_execute(params, "create_nft");

                    const networkSetting = runtime.getSetting("MOVEMENT_NETWORK") || DEFAULT_NETWORK;
                        const network = MOVEMENT_NETWORK_CONFIG[networkSetting] || MOVEMENT_NETWORK_CONFIG[DEFAULT_NETWORK];
                    
                    if (result.success) {
                        return {
                            response: `✨ Successfully created your NFT!\n\nView transaction: ${MOVEMENT_EXPLORER_URL}/txn/${result.transactionId}?network=${network.explorerNetwork}`,
                            action: "NFT_CREATED"
                        };
                    } else {
                        return {
                            response: result.error || ERROR_MESSAGES.GENERIC_ERROR,
                            action: "ERROR"
                        };
                    }
                } catch (error) {
                    elizaLogger.error("NFTPlugin: Error in create_nft action:", error);
                    return {
                        response: this.getErrorMessage(error),
                        action: "ERROR"
                    };
                }
            }
        };

        const createSoulBoundAction: IKeywordAction = {

            name: "create_soul_bound",
            description: "Create a soul-bound NFT from a tweet",
            examples: [
                "@gmovebot create nft for @user",
                "@gmovebot mint nft to 0x123",
                "@gmovebot create nft for myself"
            ],
            preprocessTweet: async (tweet: Tweet, runtime: IAgentRuntime): Promise<Map<string, string>> => {
                elizaLogger.info("preprocessing tweet.")
        
                let tweetImageDetail = await this.getTweetIdAndImage(tweet);
                let collectedParams = new Map<string, string>();
        
                if (tweetImageDetail.tweetId != null) {
                    collectedParams.set("tweetId", tweetImageDetail.tweetId);
                }
                if (tweetImageDetail.imageUri != null) {
                    collectedParams.set("imageUri", tweetImageDetail.imageUri);
                }
        
                return collectedParams
            },
            requiredParameters: [
                {
                    name: "recipient",
                    prompt: "Who should receive this soul-bound NFT? Please provide for yourself, username (@handle) or wallet address",
                    validator: async (value: string, runtime: IAgentRuntime): Promise<boolean> => {
                        value = value.replace('@', '');
                        return /^(\w{1,15}|0x[0-9a-fA-F]{64}|self)$/.test(value)
                    },
                    extractorTemplate: `# Task: Extract parameter value from user's message in a conversational context

Parameter to extract: recipient
Parameter description: Either myself or self, Twitter username (starting with @) or a wallet address (starting with 0x).

User's message:
{{userMessage}}

Previous conversation context:
{{conversationContext}}

# Instructions:
1. Extract the value for the specified parameter
2. Consider implicit mentions in the context
3. Consider common variations and synonyms
4. If the user mentions self, myself, me or anything related to self then value will be "self" with HIGH confidence and extracted true.
5. Return your response in this JSON format:
{
    "extracted": true/false,
    "value": "extracted_value or null if not found",
    "confidence": "HIGH/MEDIUM/LOW",
    "alternativeValues": ["other", "possible", "interpretations"],
    "clarificationNeeded": true/false,
    "suggestedPrompt": "A natural way to ask for clarification if needed",
    "reasoning": "Brief explanation of the extraction logic"
}

Only respond with the JSON, no other text.`
                }
            ],
            action: async (tweet: Tweet, runtime: IAgentRuntime, params: Map<string, string>) => {
                try {
                    const isSelfSoulBound = params.get("recipient")?.toLowerCase() === "self";
                    let recipient = isSelfSoulBound ? `@${tweet.username}` : (
                        params.get("recipient").startsWith("0x") ? 
                        params.get("recipient") : `@${params.get("recipient")}`);

                    // Get tweet ID and image based on context
                    const { tweetId, imageUri } = { tweetId: params.get("tweetId"), imageUri: params.get("imageUri") }
                    if (!imageUri) {
                        return {
                            response: ERROR_MESSAGES.IMAGE_GENERATION_ERROR,
                            action: "ERROR"
                        };
                    }

                    // If not self soul-bound, resolve recipient address
                    if (recipient.startsWith("@")) {
                        const username = recipient.substring(1);
                        const network = MOVEMENT_NETWORK_CONFIG[DEFAULT_NETWORK];
                        const aptosClient = new Aptos(new AptosConfig({
                            network: Network.CUSTOM,
                            fullnode: network.fullnode,
                        }));
                        
                        const resolvedAddress = await this.getUserWalletAddress(
                            username,
                            aptosClient,
                            "0xf17f471f57b12eb5a8bd1d722b385b5f1f0606d07b553828c344fb4949fd2a9d"
                        );
                        
                        if (!resolvedAddress) {
                            return {
                                response: ERROR_MESSAGES.WALLET_RESOLVE_ERROR,
                                action: "ERROR"
                            };
                        }
                        recipient = resolvedAddress;
                    }

                    const nftParams: NFTCreationParams = {
                        username: tweet.username,
                        tweetId,
                        profileUri: this.getProfileUrl(tweet.username),
                        imageUri,
                        recipient,
                        isSelfSoulBound
                    };

                    const result = await this.stage_execute(nftParams, "create_soul_bound");
                    
                    if (result.success) {
                        const message = isSelfSoulBound
                            ? `✨ Successfully created soul-bound NFT for yourself!`
                            : `✨ Successfully created soul-bound NFT for ${params.get("recipient")}!`;

                        const networkSetting = runtime.getSetting("MOVEMENT_NETWORK") || DEFAULT_NETWORK;
                        const network = MOVEMENT_NETWORK_CONFIG[networkSetting] || MOVEMENT_NETWORK_CONFIG[DEFAULT_NETWORK];
                            
                        return {
                            
                            response: `${message}\n\nView transaction: ${MOVEMENT_EXPLORER_URL}/txn/${result.transactionId}?network=${network.explorerNetwork}`,
                            action: "NFT_CREATED"
                        };
                    } else {
                        elizaLogger.error("error in uploading soulbound", result)
                        return {
                            response: result.error || ERROR_MESSAGES.GENERIC_ERROR,
                            action: "ERROR"
                        };
                    }
                } catch (error) {
                    elizaLogger.error("NFTPlugin: Error in create_soul_bound action:", error);
                    return {
                        response: this.getErrorMessage(error),
                        action: "ERROR"
                    };
                }
            }
        };

        const transferNFTAction: IKeywordAction = {
            name: "transfer_nft",
            description: "Transfer an NFT to another user or address",
            examples: [
                "@gmovebot transfer nft #0001 to @user",
                "@gmovebot send nft First User#0001 to 0x123...",
                "@gmovebot transfer my nft #0002 to @recipient"
            ],
            requiredParameters: [
                {
                    name: "nftName",
                    prompt: "Which NFT would you like to transfer? Please provide the NFT name (e.g., username#0001)",
                    validator: (value: string) => /^[A-Za-z0-9_]+#\d{4}$/.test(value)
                },
                {
                    name: "recipient",
                    prompt: "Who would you like to transfer this NFT to? Please provide a username (@handle) or wallet address.",
                    validator: (value: string) => /^(@\w{1,15}|0x[0-9a-fA-F]{64})$/.test(value)
                }
            ],
            action: async (tweet: Tweet, runtime: IAgentRuntime, params: Map<string, string>) => {
                try {
                    let recipient = params.get("recipient");
                    const nftName = params.get("nftName");

                    // Fetch user profile information
                    const userInfo = await fetchTwitterUser(tweet.username, this.client);
                    if (!userInfo) {
                        return {
                            response: ERROR_MESSAGES.PROFILE_FETCH_ERROR,
                            action: "ERROR"
                        };
                    }

                    // Resolve recipient address if it's a Twitter handle
                    if (recipient.startsWith("@")) {
                        const username = recipient.substring(1);
                        const network = MOVEMENT_NETWORK_CONFIG[DEFAULT_NETWORK];
                        const aptosClient = new Aptos(new AptosConfig({
                            network: Network.CUSTOM,
                            fullnode: network.fullnode,
                        }));
                        
                        const resolvedAddress = await this.getUserWalletAddress(
                            username,
                            aptosClient,
                            "0xf17f471f57b12eb5a8bd1d722b385b5f1f0606d07b553828c344fb4949fd2a9d"
                        );
                        
                        if (!resolvedAddress) {
                            return {
                                response: ERROR_MESSAGES.WALLET_RESOLVE_ERROR,
                                action: "ERROR"
                            };
                        }
                        recipient = resolvedAddress;
                    }

                    const transferParams: NFTCreationParams = {
                        username: tweet.username,
                        tweetId: tweet.id,
                        profileUri: this.getProfileUrl(tweet.username),
                        imageUri: "",
                        recipient,
                        nftName
                    };

                    const result = await this.stage_execute(transferParams, "transfer_nft");
                    
                    if (result.success) {
                        const displayRecipient = params.get("recipient").startsWith("0x") 
                            ? params.get("recipient").substring(0, 10) + "..." 
                            : params.get("recipient");
                        
                        const networkSetting = runtime.getSetting("MOVEMENT_NETWORK") || DEFAULT_NETWORK;
                        const network = MOVEMENT_NETWORK_CONFIG[networkSetting] || MOVEMENT_NETWORK_CONFIG[DEFAULT_NETWORK];
                        
                        return {
                            response: `✨ Successfully transferred NFT ${nftName} to ${displayRecipient}!\n\nView transaction: ${MOVEMENT_EXPLORER_URL}/txn/${result.transactionId}?network=${network.explorerNetwork}`,
                            action: "NFT_TRANSFERRED"
                        };
                    } else {
                        return {
                            response: result.error || ERROR_MESSAGES.GENERIC_ERROR,
                            action: "ERROR"
                        };
                    }
                } catch (error) {
                    elizaLogger.error("NFTPlugin: Error in transfer_nft action:", error);
                    return {
                        response: this.getErrorMessage(error),
                        action: "ERROR"
                    };
                }
            }
        };

        // Register all actions
        // this.registerAction(createNFTAction);
        this.registerAction(createSoulBoundAction);
        // this.registerAction(transferNFTAction);
    }
}

    // Continue with createSoulBoundNFT and transferNFT methods...
