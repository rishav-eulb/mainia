import { elizaLogger } from "@elizaos/core";
import {
    type Action,
    type IAgentRuntime,
} from "@elizaos/core";
import {
    Account,
    Aptos,
    AptosConfig,
    Ed25519PrivateKey,
    Network,
    PrivateKey,
    PrivateKeyVariants,
} from "@aptos-labs/ts-sdk";
import { MOVEMENT_NETWORK_CONFIG } from "../constants";

export interface FallbackResult {
    success: boolean;
    error?: string;
    registrationComplete?: boolean;
    message?: string;
}

export async function executeFallback(
    runtime: IAgentRuntime,
    userId: string
): Promise<FallbackResult> {
    try {
        const privateKey = runtime.getSetting("MOVEMENT_PRIVATE_KEY");
        const network = runtime.getSetting("MOVEMENT_NETWORK");
        const fallbackAddress = runtime.getSetting("FALLBACK_ADDRESS");

        const movementAccount = Account.fromPrivateKey({
            privateKey: new Ed25519PrivateKey(
                PrivateKey.formatPrivateKey(
                    privateKey,
                    PrivateKeyVariants.Ed25519
                )
            ),
        });

        const aptosClient = new Aptos(
            new AptosConfig({
                network: Network.CUSTOM,
                fullnode: MOVEMENT_NETWORK_CONFIG[network].fullnode,
            })
        );

        // Build transaction for user registration
        const tx = await aptosClient.transaction.build.simple({
            sender: movementAccount.accountAddress.toStringLong(),
            data: {
                function: `${fallbackAddress}::core::create_user`,
                typeArguments: [],
                functionArguments: [userId],
            },
        });

        const committedTransaction = await aptosClient.signAndSubmitTransaction({
            signer: movementAccount,
            transaction: tx,
        });

        const result = await aptosClient.waitForTransaction({
            transactionHash: committedTransaction.hash,
            options: {
                timeoutSecs: 30,
                checkSuccess: true
            }
        });

        // Check transaction success
        if (result.success) {
            return {
                success: true,
                registrationComplete: true,
                message: "User registration successful."
            };
        } else if (result.vm_status?.includes("quota_exceeded")) {
            return {
                success: false,
                registrationComplete: false,
                error: "You have exceeded quota limit. Kindly topup your wallet to accommodate your previous request."
            };
        } else {
            return {
                success: false,
                registrationComplete: false,
                error: "Registration failed: " + (result.vm_status || "Unknown error")
            };
        }
    } catch (error) {
        elizaLogger.error("Error in fallback action:", error);
        return {
            success: false,
            registrationComplete: false,
            error: error.message
        };
    }
}

export const fallbackAction: Action = {
    name: "FALLBACK",
    description: "Register new user in the Movement ecosystem",
    similes: ["REGISTER_USER", "CREATE_USER"],
    examples: [
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Transfer tokens",
                    action: "FALLBACK"
                }
            }
        ]
    ],
    validate: async (_runtime: IAgentRuntime, _message: any) => true,
    handler: async (runtime: IAgentRuntime, message: any) => {
        const result = await executeFallback(runtime, message.userId);
        return {
            success: result.success,
            response: result.message || result.error,
            registrationComplete: result.registrationComplete
        };
    }
};

export default fallbackAction; 