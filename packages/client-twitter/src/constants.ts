export const MOVE_DECIMALS = 8;

export const MOVEMENT_NETWORK_CONFIG = {
    mainnet: {
        fullnode: 'https://mainnet.movementnetwork.xyz/v1',
        chainId: '126',
        name: 'Movement Mainnet',
        explorerNetwork: 'mainnet'
    },
    bardock: {
        fullnode: 'https://aptos.testnet.bardock.movementlabs.xyz/v1',
        chainId: '250',
        name: 'Movement Bardock Testnet',
        explorerNetwork: 'bardock+testnet'
    },
    porto: {
        fullnode: 'https://aptos.testnet.porto.movementlabs.xyz/v1',
        chainId: '177',
        name: 'Movement Porto Testnet',
        explorerNetwork: 'porto+testnet'
    }
} as const;

export const MOVEMENT_EXPLORER_URL = 'https://explorer.movementnetwork.xyz/';

export const DEFAULT_NETWORK = 'porto';