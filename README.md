# 3 Repos Merged Orca Whirlpools, Phantom/Docs and Phantom/sol-wallet-adapter
### For use with AI Documentation services such as www.deepwiki.com
Very messy excuse the disorganisation


[![npm (scoped)](https://img.shields.io/npm/v/@project-serum/sol-wallet-adapter)](https://www.npmjs.com/package/@project-serum/sol-wallet-adapter)
[![Build Status](https://travis-ci.com/project-serum/sol-wallet-adapter.svg?branch=master)](https://travis-ci.com/project-serum/sol-wallet-adapter)

# sol-wallet-adapter

Library to allow Solana dApps to use third-party wallets to sign transactions.

## Install

```bash
npm install --save @project-serum/sol-wallet-adapter
```

## Usage

```js
import { Connection, SystemProgram, clusterApiUrl } from '@solana/web3.js';

let connection = new Connection(clusterApiUrl('devnet'));
let providerUrl = 'https://www.sollet.io';
let wallet = new Wallet(providerUrl);
wallet.on('connect', publicKey => console.log('Connected to ' + publicKey.toBase58()));
wallet.on('disconnect', () => console.log('Disconnected'));
await wallet.connect();

let transaction = SystemProgram.transfer({
  fromPubkey: wallet.publicKey,
  toPubkey: wallet.publicKey,
  lamports: 100,
});
let { blockhash } = await connection.getRecentBlockhash();
transaction.recentBlockhash = blockhash;
let signed = await wallet.signTransaction(transaction);
let txid = await connection.sendRawTransaction(signed.serialize());
await connection.confirmTransaction(txid);
```

See [example/src/App.js](https://github.com/serum-foundation/sol-wallet-adapter/blob/master/example/src/App.js) for a full example.

## Development

Run `yarn start` in the root directory, then run `yarn start` in the example directory.

See [create-react-library](https://github.com/transitive-bullshit/create-react-library#development) for details.

## Wallet Providers

Wallet providers are third-party webapps that provide an API to retrieve the user's accounts and sign transactions with it. `sol-wallet-adapter` opens wallet providers in a popup and communicates with it using [JSON-RPC](https://www.jsonrpc.org/specification) over [`postMessage`](https://developer.mozilla.org/en-US/docs/Web/API/Window/postMessage).

See [`spl-token-wallet`](https://github.com/serum-foundation/spl-token-wallet/blob/master/src/pages/PopupPage.js) for an example wallet provider implementation.

The general flow is as follows:

1. User selects a wallet provider to connect to, e.g. `https://www.sollet.io`
2. dApp opens the wallet provider in a popup, passing it the [origin](https://developer.mozilla.org/en-US/docs/Glossary/Origin) of the dApp and the desired network in the URL hash.
    - e.g. `https://www.sollet.io/#origin=https://www.example.com&network=mainnet-beta`
3. Wallet provider detects that `window.opener` is set and asks the user if they want to connect the wallet to the dApp.
    - The wallet UI should show the origin of the requesting dApp.
    - The origin can be retrieved from the URL hash using `new URLSearchParams(window.location.hash.slice(1)).get('origin')`.
    - If the wallet provider supports multiple accounts, it should allow the user to select which account to use.
4. If the user accepts, the wallet provider sends a [`connected`](#connected) message to the dApp via `postMessage`.
    - e.g. ```window.opener.postMessage({jsonrpc: '2.0', method: 'connected', params: {publicKey: 'EdWqEgu54Zezi4E6L72RxAMPr5SWAyt2vpZWgvPYQTLh'}}, 'https://www.example.com')'```
    - To prevent origin spoofing, the `postMessage` call must set `targetOrigin` to the dApp origin that was shown to the user in step 3.
5. When the dApp needs to send a transaction on behalf of the user, the dApp generates a transaction and sends it to the wallet provider as a [`signTransaction`](#signtransaction) request using `postMessage`.
    - The wallet provider should listen for `window.onmessage` events.
    - Before processing a [MessageEvent](https://developer.mozilla.org/en-US/docs/Web/API/MessageEvent), the wallet provider should verify that `event.origin` matches the dApp `origin` and `event.source === window.opener`.
6. The wallet provider decodes the transaction, presents it to the user, and asks the user if they would like to sign the transaction.
    - The wallet should inform the user about any potential effects of the transaction
    - For instructions that the wallet recognizes, the wallet can decode the instruction and show it to the user.
    - For instructions that the wallet does not recognize, the wallet can e.g. show the set of writable addresses included in the instruction and the programs to which those addresses belong.
    - The wallet should use the transaction blockhash to verify that the transaction will be broadcasted on the correct network.
7. The wallet sends a JSON-RPC reply back to the dApp, either with a signature if the user accepted the request or an error if the user rejected the request.
8. The dApp receives the signature, adds it to the transaction, and broadcasts it.

Wallet provider developers can use the [example webapp](https://github.com/serum-foundation/sol-wallet-adapter/tree/master/example) to test their implementation.

### URL hash parameters

- `origin` - origin of the dApp. Should be included in all `postMessage` calls and should be checked against all received `MessageEvent`s.
- `network` - The network on which transactions will be sent. Can be any of `mainnet-beta`, `devnet`, `testnet`, or a custom URL, though wallets are free to reject any unsupported networks. Wallet providers should check that transaction blockhashes matches the network before signing the transaction.

The parameters can be parsed using

```js
let params = new URLSearchParams(window.location.hash.slice(1));
let origin = params.get('origin');
let network = params.get('network');
```

### Requests from the wallet provider to the dApp (`sol-wallet-adapter`)

#### connected

Sent by the wallet provider when the user selects an account to connect to the dApp.

##### Parameters

- `publicKey` - Base-58 encoded public key of the selected account.

##### Example

```js
window.opener.postMessage({
  jsonrpc: '2.0',
  method: 'connected',
  params: {
    publicKey: 'HsQhg1k93vEA326SXxnGj1sZrdupG7rj5T6g5cMgk1ed',
  },
}, origin);
```

#### disconnected

Sent by the wallet provider when the user no longer wishes to connect to the dApp, or if the user closes the popup (`onbeforeunload`).


##### Parameters

None.

##### Example

```js
window.opener.postMessage({
  jsonrpc: '2.0',
  method: 'disconnected',
}, origin);
```

### Requests from the dApp (`sol-wallet-adapter`) to the wallet provider

#### signTransaction

Sent by the dApp when it needs to send a transaction on behalf of the user.

##### Parameters

- `message` - Base-58 encoded transaction message for the wallet to sign. Generated by [`transaction.serializeMessage()`](https://solana-labs.github.io/solana-web3.js/class/src/transaction.js~Transaction.html#instance-method-serializeMessage).

##### Results

- `signature` - Base-58 encoded transaction signature, i.e. `bs58.encode(nacl.sign.detached(message, account.secretKey))`.
- `publicKey` - Base-58 encoded public key of the account that provided the signature.

##### Example

```js
let request = {
  jsonrpc: '2.0',
  method: 'signTransaction',
  params: {
    message: "QwE1mEmQpjGKTQz9U3N8xTJCqCry9kgvJff51kVv8h5AyVGh3L…NfV68ERMb2WsVAstN',
  },
  id: 1,
};

let response = {
  jsonrpc: '2.0',
  result: {
    signature: "2HT61qv1xxWUpx7DXZM3K878wU1JJx5eKNWw64cgeauwx6sZNKtDkSRrGvqZmsRwz6c1RwkUFnPj1LXkjNtsCd9o",
    publicKey: 'HsQhg1k93vEA326SXxnGj1sZrdupG7rj5T6g5cMgk1ed'
  },
  id: 1,
};
```


# Whirlpools

Whirpools is an open-source concentrated liquidity AMM contract on the Solana blockchain.
This repository contains the Rust smart contract and SDKs to interact with a deployed program.

The official deployment of the whirlpool contract can be found at the `whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc` address on:
- [Solana Mainnet](https://solscan.io/account/whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc)
- [Solana Devnet](https://solscan.io/account/whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc?cluster=devnet)

The contract is deployed using verifiable build, so that you can ensure that the hash of the on-chain program matches the hash of the program in this codebase.
- [Solana Verify CLI](https://github.com/Ellipsis-Labs/solana-verifiable-build)
- [Verification result on Osec API](https://verify.osec.io/status/whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc)

The program has been audited several times by different security firms.
* Jan 28th, 2022 - [Kudelski Security](/.audits/2022-01-28.pdf)
* May 5th, 2022 - [Neodyme](/.audits/2022-05-05.pdf)
* Aug 21st, 2024 - [OtterSec](/.audits/2024-08-21.pdf)

## Usage

This repository contains several libraries that can be used to interact with the Whirlpools contract. For most purposes you can use our high-level SDKs, `@orca-so/whirlpools` for Typescript projects, and `orca_whirlpools` for Rust projects.

For specific use-cases you can opt for integrating with lower level packages such as:
* `@orca-so/whirlpools-client` & `orca_whirlpools_client` - auto-generated client for the Whirlpools program that contains account, instruction and error parsing.
* `@orca-so/whirlpools-core` & `orca_whirlpools_core` - utility, math and quoting functions used by other packages.

The legacy Typescript SDK (`@orca-so/whirlpools-sdk`) remains a solid choice, and it’s currently the only option if your project uses Solana Web3.js.

For a more detailed overview of our SDK suite and usage examples, visit our [developer documentation](https://dev.orca.so/) site.

## Local Development

This monorepo contains all the code needed to build, deploy and interact with the Whirlpools contract.

### Requirements

- Anchor v0.29.0
- Solana v1.17.22

### Getting Started

These instructions are for setting up a development environment on a Mac. If you are using a different operating system, you will need to adjust the instructions accordingly.

* Install NodeJS and gcc-12 using `brew install node gcc@12`.
* Add gcc-12 headers to your cpath using `export CPATH="/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk/usr/include"`.
* Install Rust lang using `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh`.
* Install the Solana CLI using `curl -sSfL https://release.solana.com/v1.17.22/install | sh`.
* Add the Solana CLI to your path using `export PATH="/Users/$(whoami)/.local/share/solana/install/active_release/bin:$PATH"`.
* Install Anchor version manager using `cargo install --git https://github.com/coral-xyz/anchor avm --locked --force`.
* Install the latest Anchor version using `avm install 0.29.0 && avm use 0.29.0`.
* Clone this repository using `git clone https://github.com/orca-so/whirlpools`.
* Install the dependencies using `yarn`.
* Set up a Solana wallet if you don't have one already (see below).
* Run one of the commands below to get started such as `yarn build`.

#### Setting up a Solana wallet

* Create a new keypair using `solana-keygen new`.
* Check if you have a valid wallet address using `solana address`.
* Set your local config to the Solana devnet env using `solana config set --url https://api.devnet.solana.com`.
* Give yourself some devnet SOL (for transaction fees) using `solana airdrop 1`.
* Check if you have a positive balance using `solana balance`.

### Components

This repository uses NX to manage the Rust and Typescript codebases. This allows us to have a monorepo with multiple packages and share code between them. Dependencies between packages are automatically resolved by NX, so you don't have to worry about managing that yourself.

This repository is split up into sevaral parts. The following is a (non-exhaustive) list of the components and their purpose.

* **`/programs/*`** - Rust programs that are deployed on Solana.
* **`/ts-sdk/*`** - Typescript SDKs for interacting with the programs.
* **`/rust-sdk/*`** - Rust SDKs for interacting with the programs.
* **`/docs/*`** - Documentation for the programs and SDKs.
* **`/legacy-sdk/*`** - Legacy Typescript SDKs and integration tests.

### Commands

All commands should be run from the root of the repository. NX will try to run a command with the same name for each individual component, skipping the component if that specific command does not exist.

Below is a (non-exhaustive) list of available commands:
* **`yarn build`** - compile the components for deployment or serving.
* **`yarn clean`** - clean up all local build products, useful for when builds are failing.
* **`yarn test`** - run the tests for all components.
* **`yarn format`** - run formatter to format code.

If you look closely, the commands just call individual commands specified in the component's `package.json` file. These commands should not be run by themselves as it will not resolve the right dependencies and will not execute the prerequisites. Instead you can specify which package to run with `yarn build programs/whirlpool`, `yarn test legacy-sdk/whirlpool`, etc.

If you want to stream the logs of a specific command you can add the `--output-style stream` flag to the command. This allows you to view the logs of the command as they are being produced which can be useful for longer running tasks like integration tests.

### Changesets

When contributing to this repository, please include a changeset with your changes. You can create a changeset by running `yarn changeset`. If your changes are not related to any of the packages, you can create an empty changeset by running `yarn changeset --empty`. In your pull request, you do not have to manually update the version numbers.

To publish packages to npm and cargo, you can run run the `publish` gh action. This will update the versions of the packages and publish them to npm and cargo.

# Support

Have problems integrating with the SDK? Pop by over to the Orca [Discord](https://discord.gg/nSwGWn5KSG) #dev-questions channel and chat with one of our engineers.

### Feedback

Got ideas on how to improve the system? Open up an issue on github and let's brainstorm more about it together!



---
cover: .gitbook/assets/phantom-background.jpeg
coverY: -50.54759898904802
---

# Phantom Docs Introduction

**Phantom** is a crypto wallet that can be used to manage digital assets and access decentralized applications on [Solana](https://solana.com/), [Polygon](https://polygon.technology/), and [Ethereum](https://ethereum.org/en/).&#x20;

Phantom is currently available as:

* A [browser extension](https://phantom.app/download)
* An [iOS app](https://apps.apple.com/us/app/phantom-solana-wallet/id1598432977)
* An [Android app](https://play.google.com/store/apps/details?id=app.phantom)

At its core, Phantom works by creating and managing private keys on behalf of its users. These keys can then be used within Phantom to store funds and sign transactions.&#x20;

Developers can interact with Phantom via both **web** applications as well as **iOS and Android** applications.

To interact with web applications, the Phantom [extension and mobile in-app browser](broken-reference) injects a `phantom` object into the javascript context of every site the user visits. A given web app may then interact with Phantom, and ask for the user's permission to perform transactions, through this injected provider.

It's also possible to interact with the Phantom mobile app through [universal links and deeplinks](phantom-deeplinks/deeplinks-ios-and-android.md). With deeplinks, mobile apps can prompt their users to connect, sign, and send with Phantom directly. Once complete, Phantom will redirect users back to their referring applications.

This documentation is intended for developers who are building applications with Phantom. If you are a developer looking for help with an integration, please check out our [developer discord.](https://discord.gg/j5Dp7ztzvW) For all other support requests, please visit our [Help Center](https://help.phantom.app/).

