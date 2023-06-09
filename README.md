**DEPRECATED see our new protocol [here](https://github.com/detaprotocol/solo)**

Source code for Ethereum Smart Contracts used by the deta Margin Trading Protocol

[Whitepaper](https://whitepaper.deta.exchange)

[Short & Leveraged Long Tokens Whitepaper](https://margintokens.deta.exchange)

## Npm Package

The npm package contains the deployed addresses of the contracts, and also allows access to seed positions and orders on the docker test container

#### Install

```
npm install --save @detaprotocol/protocol
```

#### Contracts

```javascript
import { Margin as MarginContract } from '@detaprotocol/protocol';
import truffleContract from 'truffle-contract';

async function openPosition(provider, networkId) {
  const Margin = truffleContract(MarginContract);

  Margin.setProvider(provider);
  Margin.setNetwork(networkId);

  const margin = await Margin.deployed();

  await margin.openPosition(...);
}
```

#### Seed Positions / Orders

Seed positions are available and already deployed on the docker container

```javascript
import { seeds } from '@detaprotocol/protocol';

const position = seeds.positions[2];

console.log(position.id);
console.log(position.isTokenized);

// Test 0x V1 orders. Maker already has balance and allowance set
const order = seeds.orders[1];

console.log(order.maker);
```

#### Snapshotting

When using the docker container, you can reset the evm to the default state. This can be useful when running automated test suites

```javascript
import { resetEVM } from '@detaprotocol/protocol';

await resetEVM(web3.currentProvider);
```

## Docker Container

[Docker container](https://store.docker.com/community/images/detaprotocol/protocol/tags) with a a deployed version of the protocol running on a ganache-cli node with network_id = 1212. Docker container versions correspond to npm versions of this package, so use the same version for both

```
docker pull detaprotocol/protocol
docker run detaprotocol/protocol
```

#### Docker Compose

```
# docker-compose.yml

version: '3'
services:
  protocol:
    image: detaprotocol/protocol:latest
    ports:
      - 8545:8545
```

## Development

#### Install

```
npm install
```

#### Compile

```
npm run compile
```

#### Test

```
npm test
```

#### Lint

Lint the javascript files (tests, deploy scripts)
```
npm run lint
```


Lint the solidity files (all smart contracts)
```
npm run solint
```

Lint the solidity files (custom deta linter)
```
npm run detalint
```

## Architecture

### Contracts

#### Base Protocol

##### Margin.sol

Contains business logic for margin trading. All external functions for margin trading are in this contract.

##### TokenProxy.sol

Used to transfer user funds. Users set token allowance for the proxy authorizing it to transfer their funds. Only allows authorized contracts to transfer funds.

##### Vault.sol

Holds all token funds. Is authorized to transfer user funds via the TokenProxy. Allows authorized contracts to withdraw funds.

#### Second Layer

##### ZeroExV1ExchangeWrapper.sol

Allows positions to be opened or closed using 0x orders. Wraps the 0x Exchange Contract in a standard interface usable by Margin.

##### ERC20Short.sol

Allows short positions to be tokenized as ERC20 tokens. Ownership of a short token grants ownership of a proportional piece of the backing position.

##### ERC20Long.sol

Allows leveraged long positions to be tokenized as ERC20 tokens. Ownership of a leveraged long token grants ownership of a proportional piece of the backing position.

##### ERC721Position.sol

Allows margin positions to be represented as ERC721 tokens.

##### ERC721MarginLoan.sol

Allows loans to be represented as ERC721 tokens.

##### DutchAuctionCloser.sol

Allows margin positions to be automatically close via a dutch auction.

##### SharedLoan.sol

Allows multiple lenders to share in a loan position together.

_Read more about our smart contract architecture [here](https://docs.google.com/document/d/19mc4Jegby5o2IPkhrR2QawNmE45NMYVL6U23YygEfts/edit?usp=sharing)_
