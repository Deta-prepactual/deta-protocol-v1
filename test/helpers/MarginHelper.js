const expect = require('chai').expect;
const Web3 = require('web3');
const BigNumber = require('bignumber.js');

const Margin = artifacts.require("Margin");
const HeldToken = artifacts.require("TokenA");
const OwedToken = artifacts.require("TokenB");
const FeeToken = artifacts.require("TokenC");
const TokenProxy = artifacts.require("TokenProxy");
const Vault = artifacts.require("Vault");
const InterestImpl = artifacts.require("InterestImpl");
const TestInterestImpl = artifacts.require("TestInterestImpl");
const ZeroExV1ExchangeWrapper = artifacts.require("ZeroExV1ExchangeWrapper");
const { ZeroExProxyV1 } = require('../contracts/ZeroExV1');

const { DEFAULT_SALT, ORDER_TYPE, BYTES } = require('./Constants');
const { zeroExV1OrderToBytes, zeroExV2OrderToBytes } = require('./BytesHelper');
const { createSignedV1BuyOrder, createSignedV1SellOrder } = require('./ZeroExV1Helper');
const { transact } = require('./ContractHelper');
const { expectLog } = require('./EventHelper');
const { createLoanOffering, setLoanHash } = require('./LoanHelper');
const { getPartialAmount } = require('../helpers/MathHelper');
const { getBlockTimestamp } = require('./NodeHelper');
const { issueAndSetAllowance } = require('./TokenHelper');

const web3Instance = new Web3(web3.currentProvider);

BigNumber.config({ DECIMAL_PLACES: 80 });

async function createOpenTx(
  accounts,
  {
    salt = DEFAULT_SALT,
    depositInHeldToken = true,
    positionOwner,
    interestPeriod,
    loanOwner,
    nonce,
    trader,
    owedToken,
    heldToken,
  } = {}
) {
  const [loanOffering, buyOrder] = await Promise.all([
    createLoanOffering(accounts, { salt, interestPeriod, loanOwner }),
    createSignedV1BuyOrder(accounts, { salt })
  ]);

  const tx = {
    owner: positionOwner || accounts[0],
    owedToken: owedToken || OwedToken.address,
    heldToken: heldToken || HeldToken.address,
    principal: new BigNumber('1098765932109876544'),
    loanOffering: loanOffering,
    buyOrder: buyOrder,
    trader: trader || accounts[0],
    exchangeWrapper: ZeroExV1ExchangeWrapper.address,
    depositInHeldToken: depositInHeldToken,
    nonce: nonce || Math.floor(Math.random() * 12983748912748)
  };
  tx.depositAmount = getMinimumDeposit(tx);

  const positionId = web3Instance.utils.soliditySha3(
    tx.trader,
    tx.nonce
  );

  tx.id = positionId;

  return tx;
}

function getMinimumDeposit(openTx) {
  let minimumDeposit;

  const totalCollateralRequired = getPartialAmount(
    openTx.principal,
    openTx.loanOffering.rates.maxAmount,
    openTx.loanOffering.rates.minHeldToken,
    true
  );

  if (openTx.depositInHeldToken) {
    const heldTokenFromSell = getPartialAmount(
      openTx.principal,
      openTx.buyOrder.takerTokenAmount,
      openTx.buyOrder.makerTokenAmount
    );
    minimumDeposit = totalCollateralRequired.minus(heldTokenFromSell);
  } else {
    const owedTokenNeededToSell = getPartialAmount(
      totalCollateralRequired,
      openTx.buyOrder.makerTokenAmount,
      openTx.buyOrder.takerTokenAmount,
      true
    );
    minimumDeposit = owedTokenNeededToSell.minus(openTx.principal);
  }

  expect(minimumDeposit).to.be.bignumber.gt(0);
  return minimumDeposit;
}

function orderToBytes(order) {
  switch (order.type) {
  case ORDER_TYPE.ZERO_EX_V1: {
    return zeroExV1OrderToBytes(order);
  }
  case ORDER_TYPE.ZERO_EX_V2: {
    return zeroExV2OrderToBytes(order);
  }
  case ORDER_TYPE.DIRECT: {
    return BYTES.EMPTY;
  }
  default:
    return null;
  }
}

async function callOpenPosition(
  detaMargin,
  tx,
  {
    collisionCheck = true
  } = {}
) {
  const positionId = web3Instance.utils.soliditySha3(
    tx.trader,
    tx.nonce
  );

  if (collisionCheck) {
    let [contains, contained] = await Promise.all([
      detaMargin.containsPosition.call(positionId),
      detaMargin.isPositionClosed.call(positionId)
    ]);
    expect(contains).to.be.false;
    expect(contained).to.be.false;
  }

  const addresses = [
    tx.owner,
    tx.loanOffering.owedToken,
    tx.loanOffering.heldToken,
    tx.loanOffering.payer,
    tx.loanOffering.owner,
    tx.loanOffering.taker,
    tx.loanOffering.positionOwner,
    tx.loanOffering.feeRecipient,
    tx.loanOffering.lenderFeeTokenAddress,
    tx.loanOffering.takerFeeTokenAddress,
    tx.exchangeWrapper
  ];

  const values256 = [
    tx.loanOffering.rates.maxAmount,
    tx.loanOffering.rates.minAmount,
    tx.loanOffering.rates.minHeldToken,
    tx.loanOffering.rates.lenderFee,
    tx.loanOffering.rates.takerFee,
    tx.loanOffering.expirationTimestamp,
    tx.loanOffering.salt,
    tx.principal,
    tx.depositAmount,
    tx.nonce
  ];

  const values32 = [
    tx.loanOffering.callTimeLimit,
    tx.loanOffering.maxDuration,
    tx.loanOffering.rates.interestRate,
    tx.loanOffering.rates.interestPeriod
  ];

  const order = orderToBytes(tx.buyOrder);

  let response = await detaMargin.openPosition(
    addresses,
    values256,
    values32,
    tx.depositInHeldToken,
    tx.loanOffering.signature,
    order,
    { from: tx.trader }
  );

  const contains = await detaMargin.containsPosition.call(positionId);
  expect(contains).to.be.true;

  await expectLogOpenPosition(detaMargin, positionId, tx, response);

  response.id = positionId;
  return response;
}

function getExpectedHeldTokenFromSell(tx) {
  switch (tx.buyOrder.type){
  case ORDER_TYPE.ZERO_EX_V1:
  case ORDER_TYPE.ZERO_EX_V2: {
    let soldAmount = tx.principal;
    if (!tx.depositInHeldToken) {
      soldAmount = soldAmount.plus(tx.depositAmount)
    }
    return getPartialAmount(
      soldAmount,
      tx.buyOrder.takerTokenAmount,
      tx.buyOrder.makerTokenAmount
    );
  }
  case ORDER_TYPE.DIRECT: {
    return new BigNumber(0);
  }
  default:
    return null;
  }
}

async function expectLogOpenPosition(detaMargin, positionId, tx, response) {
  const expectedHeldTokenFromSell = getExpectedHeldTokenFromSell(tx);

  setLoanHash(tx.loanOffering);

  expectLog(response.logs[0], 'PositionOpened', {
    positionId: positionId,
    trader: tx.trader,
    lender: tx.loanOffering.payer,
    loanHash: tx.loanOffering.loanHash,
    owedToken: tx.loanOffering.owedToken,
    heldToken: tx.loanOffering.heldToken,
    loanFeeRecipient: tx.loanOffering.feeRecipient,
    principal: tx.principal,
    heldTokenFromSell: expectedHeldTokenFromSell,
    depositAmount: tx.depositAmount,
    interestRate: tx.loanOffering.rates.interestRate,
    callTimeLimit: tx.loanOffering.callTimeLimit,
    maxDuration: tx.loanOffering.maxDuration,
    depositInHeldToken: tx.depositInHeldToken
  });

  const newOwner = await detaMargin.getPositionOwner.call(positionId);
  const newLender = await detaMargin.getPositionLender.call(positionId);
  let logIndex = 0;
  if (tx.owner !== tx.trader) {
    expectLog(response.logs[++logIndex], 'PositionTransferred', {
      positionId: positionId,
      from: tx.trader,
      to: tx.owner
    });
    if (newOwner !== tx.owner) {
      expectLog(response.logs[++logIndex], 'PositionTransferred', {
        positionId: positionId,
        from: tx.owner,
        to: newOwner
      });
    }
  }
  if (tx.loanOffering.owner !== tx.loanOffering.payer) {
    expectLog(response.logs[++logIndex], 'LoanTransferred', {
      positionId: positionId,
      from: tx.loanOffering.payer,
      to: tx.loanOffering.owner
    });
    if (newLender !== tx.loanOffering.owner) {
      expectLog(response.logs[++logIndex], 'LoanTransferred', {
        positionId: positionId,
        from: tx.loanOffering.owner,
        to: newLender
      });
    }
  }
}

async function callIncreasePosition(detaMargin, tx) {
  const positionId = tx.id;

  const addresses = [
    tx.loanOffering.payer,
    tx.loanOffering.taker,
    tx.loanOffering.positionOwner,
    tx.loanOffering.feeRecipient,
    tx.loanOffering.lenderFeeTokenAddress,
    tx.loanOffering.takerFeeTokenAddress,
    tx.exchangeWrapper
  ];

  const values256 = [
    tx.loanOffering.rates.maxAmount,
    tx.loanOffering.rates.minAmount,
    tx.loanOffering.rates.minHeldToken,
    tx.loanOffering.rates.lenderFee,
    tx.loanOffering.rates.takerFee,
    tx.loanOffering.expirationTimestamp,
    tx.loanOffering.salt,
    tx.principal
  ];

  const values32 = [
    tx.loanOffering.callTimeLimit,
    tx.loanOffering.maxDuration
  ];

  const order = orderToBytes(tx.buyOrder);

  const [principal, balance] = await Promise.all([
    detaMargin.getPositionPrincipal.call(positionId),
    detaMargin.getPositionBalance.call(positionId)
  ]);

  let response = await detaMargin.increasePosition(
    positionId,
    addresses,
    values256,
    values32,
    tx.depositInHeldToken,
    tx.loanOffering.signature,
    order,
    { from: tx.trader }
  );

  await expectIncreasePositionLog(
    detaMargin,
    tx,
    response,
    { principal, balance }
  );

  response.id = positionId;
  return response;
}

async function expectIncreasePositionLog(detaMargin, tx, response, start) {
  const positionId = tx.id;
  const [owner, time1, time2, principal, endingBalance] = await Promise.all([
    detaMargin.getPositionOwner.call(positionId),
    detaMargin.getPositionStartTimestamp.call(positionId),
    getBlockTimestamp(response.receipt.blockNumber),
    detaMargin.getPositionPrincipal.call(positionId),
    detaMargin.getPositionBalance.call(positionId)
  ]);
  const owed = await getOwedAmountForTime(
    new BigNumber(time2).minus(time1),
    tx.loanOffering.rates.interestPeriod,
    tx.loanOffering.rates.interestRate,
    tx.principal,
    false
  );
  const minTotalDeposit = getPartialAmount(
    endingBalance,
    principal,
    tx.principal,
    true
  );
  let heldTokenFromSell;
  if (tx.buyOrder.type === ORDER_TYPE.ZERO_EX_V1) {
    heldTokenFromSell = tx.depositInHeldToken ?
      getPartialAmount(
        owed,
        tx.buyOrder.takerTokenAmount,
        tx.buyOrder.makerTokenAmount
      )
      : minTotalDeposit;
  } else if (tx.buyOrder.type === ORDER_TYPE.DIRECT) {
    heldTokenFromSell = 0;
  }
  const depositAmount = tx.depositInHeldToken ?
    minTotalDeposit.minus(heldTokenFromSell)
    : getPartialAmount(
      tx.buyOrder.takerTokenAmount,
      tx.buyOrder.makerTokenAmount,
      minTotalDeposit,
      true
    ).minus(owed);

  setLoanHash(tx.loanOffering);

  expectLog(response.logs[0], 'PositionIncreased', {
    positionId: positionId,
    trader: tx.trader,
    lender: tx.loanOffering.payer,
    positionOwner: owner,
    loanOwner: tx.loanOffering.owner,
    loanHash: tx.loanOffering.loanHash,
    loanFeeRecipient: tx.loanOffering.feeRecipient,
    amountBorrowed: owed,
    principalAdded: tx.principal,
    heldTokenFromSell,
    depositAmount,
    depositInHeldToken: tx.depositInHeldToken
  });

  const youMustAddThisMuchCollateralToPosition = getPartialAmount(
    owed,
    tx.loanOffering.rates.maxAmount,
    tx.loanOffering.rates.minHeldToken,
    true
  );
  expect(endingBalance.minus(start.balance)).to.be.bignumber.gte(
    youMustAddThisMuchCollateralToPosition
  );
}

async function issueTokensAndSetAllowances(tx) {
  const [owedToken, heldToken, feeToken] = await Promise.all([
    OwedToken.deployed(),
    HeldToken.deployed(),
    FeeToken.deployed()
  ]);

  const depositToken = tx.depositInHeldToken ? heldToken : owedToken;

  await Promise.all([
    // Loan Payer Owed Token
    issueAndSetAllowance(
      owedToken,
      tx.loanOffering.payer,
      tx.loanOffering.rates.maxAmount,
      TokenProxy.address
    ),

    // Trader Deposit
    issueAndSetAllowance(
      depositToken,
      tx.trader,
      tx.depositAmount,
      TokenProxy.address
    ),

    // Buy Order Maker Held Token
    issueAndSetAllowance(
      heldToken,
      tx.buyOrder.maker,
      tx.buyOrder.makerTokenAmount,
      ZeroExProxyV1.address
    ),

    // Buy Order Maker Fee
    issueAndSetAllowance(
      feeToken,
      tx.buyOrder.maker,
      tx.buyOrder.makerFee,
      ZeroExProxyV1.address
    ),

    // Loan Payer Fee
    issueAndSetAllowance(
      feeToken,
      tx.loanOffering.payer,
      tx.loanOffering.rates.lenderFee,
      TokenProxy.address
    ),

    // Trader Loan Fee
    issueAndSetAllowance(
      feeToken,
      tx.trader,
      tx.loanOffering.rates.takerFee,
      TokenProxy.address
    ),

    // Trader Buy Order Fee
    issueAndSetAllowance(
      feeToken,
      tx.trader,
      tx.buyOrder.takerFee,
      ZeroExV1ExchangeWrapper.address
    ),
  ]);
}

async function doOpenPosition(
  accounts,
  {
    salt = DEFAULT_SALT,
    nonce,
    positionOwner,
    interestPeriod
  } = {}
) {
  const [openTx, detaMargin] = await Promise.all([
    createOpenTx(accounts, { salt, nonce, positionOwner, interestPeriod }),
    Margin.deployed()
  ]);

  await issueTokensAndSetAllowances(openTx);

  const response = await callOpenPosition(detaMargin, openTx);

  openTx.id = response.id;
  openTx.response = response;
  return openTx;
}

async function doClosePosition(
  accounts,
  openTx,
  closeAmount,
  {
    salt = DEFAULT_SALT,
    callCloseArgs = {}
  } = {}
) {
  const [sellOrder, detaMargin] = await Promise.all([
    createSignedV1SellOrder(accounts, { salt }),
    Margin.deployed()
  ]);
  await issueTokensAndSetAllowancesForClose(openTx, sellOrder);
  let closeTx = await callClosePosition(detaMargin, openTx, sellOrder, closeAmount, callCloseArgs);
  return closeTx;
}

async function callClosePosition(
  detaMargin,
  openTx,
  sellOrder,
  closeAmount,
  {
    from,
    recipient,
    payoutInHeldToken = true,
    exchangeWrapper = ZeroExV1ExchangeWrapper.address
  } = {}
) {
  const closer = from || openTx.trader;
  recipient = recipient || closer;

  const addresses = await getAddresses(detaMargin, openTx.id);

  const start = await getStartVariables(addresses, openTx.id);

  const tx = await transact(
    detaMargin.closePosition,
    openTx.id,
    closeAmount,
    recipient,
    exchangeWrapper,
    payoutInHeldToken,
    zeroExV1OrderToBytes(sellOrder),
    { from: closer }
  );

  await expectCloseLog(
    addresses,
    start,
    {
      openTx,
      sellOrder,
      closer,
      payoutInHeldToken,
      recipient,
      tx
    }
  );

  return tx;
}

async function callClosePositionDirectly(
  detaMargin,
  openTx,
  closeAmount,
  {
    from = null,
    recipient = null
  } = {}
) {
  const closer = from || openTx.trader;
  recipient = recipient || closer;

  const addresses = await getAddresses(detaMargin, openTx.id);

  const start = await getStartVariables(addresses, openTx.id);

  const tx = await transact(
    detaMargin.closePositionDirectly,
    openTx.id,
    closeAmount,
    recipient,
    { from: closer }
  );

  await expectCloseLog(
    addresses,
    start,
    {
      openTx,
      closer,
      payoutInHeldToken: true,
      recipient,
      tx
    }
  );

  return tx;
}

async function getAddresses(detaMargin, positionId) {
  const [
    heldToken,
    owedToken,
    lender
  ] = await Promise.all([
    HeldToken.deployed(),
    OwedToken.deployed(),
    detaMargin.getPositionLender.call(positionId)
  ]);
  return {
    detaMargin,
    heldToken,
    owedToken,
    lender,
  };
}

async function getStartVariables(addresses, positionId) {
  const [
    principal,
    balance,
    timestamp,
    totalOwedTokenRepaid,
    lenderOwedToken
  ] = await Promise.all([
    addresses.detaMargin.getPositionPrincipal.call(positionId),
    addresses.detaMargin.getPositionBalance.call(positionId),
    addresses.detaMargin.getPositionStartTimestamp.call(positionId),
    addresses.detaMargin.getTotalOwedTokenRepaidToLender.call(positionId),
    addresses.owedToken.balanceOf.call(addresses.lender)
  ]);
  return {
    principal,
    balance,
    timestamp,
    totalOwedTokenRepaid,
    lenderOwedToken,
  }
}

async function expectCloseLog(addresses, start, params) {
  const [
    endAmount,
    endTimestamp,
    endTotalOwedTokenRepaid,
    endLenderOwedToken,
  ] = await Promise.all([
    addresses.detaMargin.getPositionPrincipal.call(params.openTx.id),
    getBlockTimestamp(params.tx.receipt.blockNumber),
    addresses.detaMargin.getTotalOwedTokenRepaidToLender.call(params.openTx.id),
    addresses.owedToken.balanceOf.call(addresses.lender),
  ]);
  const actualCloseAmount = start.principal.minus(endAmount);

  const owed = await getOwedAmountForTime(
    new BigNumber(endTimestamp).minus(start.timestamp),
    params.openTx.loanOffering.rates.interestPeriod,
    params.openTx.loanOffering.rates.interestRate,
    actualCloseAmount,
    true
  );

  const availableHeldToken = getPartialAmount(
    actualCloseAmount,
    start.principal,
    start.balance
  );

  let buybackCostInHeldToken = 0;
  let payoutAmount = availableHeldToken;
  let owedTokenPaidToLender = owed;

  if (params.sellOrder) {
    if (params.payoutInHeldToken) {
      buybackCostInHeldToken = getPartialAmount(
        owed,
        params.sellOrder.makerTokenAmount,
        params.sellOrder.takerTokenAmount,
        true // round up
      );
    } else {
      buybackCostInHeldToken = availableHeldToken;
    }

    const owedTokenFromSell = getPartialAmount(
      buybackCostInHeldToken,
      params.sellOrder.takerTokenAmount,
      params.sellOrder.makerTokenAmount
    );

    if (params.payoutInHeldToken) {
      owedTokenPaidToLender = owedTokenFromSell;
      payoutAmount = availableHeldToken.minus(buybackCostInHeldToken);
    } else {
      payoutAmount = owedTokenFromSell.minus(owedTokenPaidToLender);
    }
  }

  expect(
    owedTokenPaidToLender
  ).to.be.bignumber.equal(
    endTotalOwedTokenRepaid.minus(start.totalOwedTokenRepaid)
  ).to.be.bignumber.equal(
    endLenderOwedToken.minus(start.lenderOwedToken)
  );

  expectLog(params.tx.logs[0], 'PositionClosed', {
    positionId: params.openTx.id,
    closer: params.closer,
    payoutRecipient: params.recipient,
    closeAmount: actualCloseAmount,
    remainingAmount: start.principal.minus(actualCloseAmount),
    owedTokenPaidToLender,
    payoutAmount,
    buybackCostInHeldToken,
    payoutInHeldToken: params.payoutInHeldToken
  });

  expect(params.tx.result[0]).to.be.bignumber.equal(actualCloseAmount);
  expect(params.tx.result[1]).to.be.bignumber.equal(payoutAmount);
  expect(params.tx.result[2]).to.be.bignumber.equal(owedTokenPaidToLender);
}

async function callCloseWithoutCounterparty(
  detaMargin,
  openTx,
  closeAmount,
  from,
  payoutRecipient = null
) {
  const [startAmount, startHeldToken] = await Promise.all([
    detaMargin.getPositionPrincipal.call(openTx.id),
    detaMargin.getPositionBalance.call(openTx.id)
  ]);

  payoutRecipient = payoutRecipient || from;
  const tx = await transact(
    detaMargin.closeWithoutCounterparty,
    openTx.id,
    closeAmount,
    payoutRecipient,
    { from }
  );

  const endAmount = await detaMargin.getPositionPrincipal.call(openTx.id);

  const actualCloseAmount = startAmount.minus(endAmount);

  expectLog(tx.logs[0], 'PositionClosed', {
    positionId: openTx.id,
    closer: from,
    payoutRecipient: payoutRecipient,
    closeAmount: actualCloseAmount,
    remainingAmount: startAmount.minus(actualCloseAmount),
    owedTokenPaidToLender: 0,
    payoutAmount: getPartialAmount(actualCloseAmount, startAmount, startHeldToken),
    buybackCostInHeldToken: 0,
    payoutInHeldToken: true
  });

  return tx;
}

async function callCancelLoanOffer(
  detaMargin,
  loanOffering,
  cancelAmount,
  from = null
) {
  const { addresses, values256, values32 } = formatLoanOffering(loanOffering);

  const canceledAmount1 = await detaMargin.getLoanCanceledAmount.call(loanOffering.loanHash);
  const tx = await detaMargin.cancelLoanOffering(
    addresses,
    values256,
    values32,
    cancelAmount,
    { from: from || loanOffering.payer }
  );
  const canceledAmount2 = await detaMargin.getLoanCanceledAmount.call(loanOffering.loanHash);

  const expectedCanceledAmount = BigNumber.min(
    canceledAmount1.plus(cancelAmount),
    loanOffering.rates.maxAmount
  );
  expect(canceledAmount2).to.be.bignumber.equal(expectedCanceledAmount);

  if (
    !canceledAmount1.equals(loanOffering.rates.maxAmount)
    && !(new BigNumber(cancelAmount).equals(0))
  ) {
    expectLog(tx.logs[0], 'LoanOfferingCanceled', {
      loanHash: loanOffering.loanHash,
      payer: loanOffering.payer,
      feeRecipient: loanOffering.feeRecipient,
      cancelAmount: canceledAmount2.minus(canceledAmount1)
    });
  } else {
    expect(tx.logs.length).to.eq(0);
  }

  return tx;
}

function formatLoanOffering(loanOffering) {
  const addresses = [
    loanOffering.owedToken,
    loanOffering.heldToken,
    loanOffering.payer,
    loanOffering.owner,
    loanOffering.taker,
    loanOffering.positionOwner,
    loanOffering.feeRecipient,
    FeeToken.address,
    FeeToken.address
  ];

  const values256 = [
    loanOffering.rates.maxAmount,
    loanOffering.rates.minAmount,
    loanOffering.rates.minHeldToken,
    loanOffering.rates.lenderFee,
    loanOffering.rates.takerFee,
    loanOffering.expirationTimestamp,
    loanOffering.salt,
  ];

  const values32 = [
    loanOffering.callTimeLimit,
    loanOffering.maxDuration,
    loanOffering.rates.interestRate,
    loanOffering.rates.interestPeriod
  ];

  return { addresses, values256, values32 };
}

async function issueTokensAndSetAllowancesForClose(openTx, sellOrder) {
  const [owedToken, feeToken] = await Promise.all([
    OwedToken.deployed(),
    FeeToken.deployed(),
  ]);

  await Promise.all([
    // Sell Order Owed Token
    issueAndSetAllowance(
      owedToken,
      sellOrder.maker,
      sellOrder.makerTokenAmount,
      ZeroExProxyV1.address
    ),

    // Trader Sell Order Taker Fee
    issueAndSetAllowance(
      feeToken,
      openTx.trader,
      sellOrder.takerFee,
      ZeroExV1ExchangeWrapper.address
    ),

    // Sell Order Maker Fee
    issueAndSetAllowance(
      feeToken,
      sellOrder.maker,
      sellOrder.makerFee,
      ZeroExProxyV1.address
    )
  ]);
}

async function getPosition(detaMargin, id) {
  const [
    [
      owedToken,
      heldToken,
      lender,
      owner
    ],
    [
      principal,
      requiredDeposit
    ],
    [
      callTimeLimit,
      startTimestamp,
      callTimestamp,
      maxDuration,
      interestRate,
      interestPeriod
    ]
  ] = await detaMargin.getPosition.call(id);

  return {
    owedToken,
    heldToken,
    principal,
    interestRate,
    requiredDeposit,
    callTimeLimit,
    startTimestamp,
    callTimestamp,
    maxDuration,
    interestPeriod,
    lender,
    owner
  };
}

async function doOpenPositionAndCall(
  accounts,
  {
    requiredDeposit = new BigNumber(10),
    salt = DEFAULT_SALT,
  } = {}
) {
  const [detaMargin, vault, owedToken] = await Promise.all([
    Margin.deployed(),
    Vault.deployed(),
    OwedToken.deployed()
  ]);

  const openTx = await doOpenPosition(accounts, { salt });

  const callTx = await detaMargin.marginCall(
    openTx.id,
    requiredDeposit,
    { from: openTx.loanOffering.payer }
  );

  return { detaMargin, vault, owedToken, openTx, callTx };
}

async function issueForDirectClose(openTx) {
  const owedToken = await OwedToken.deployed();

  // Issue to the trader the maximum amount of owedToken they could have to pay

  const maxInterestFee = await getMaxInterestFee(openTx);
  const maxOwedTokenOwed = openTx.principal.plus(maxInterestFee);

  await issueAndSetAllowance(
    owedToken,
    openTx.trader,
    maxOwedTokenOwed,
    TokenProxy.address
  );
}

async function getMaxInterestFee(openTx) {
  await TestInterestImpl.link('InterestImpl', InterestImpl.address);
  const interestCalc = await TestInterestImpl.new();

  const interest = await interestCalc.getCompoundedInterest.call(
    openTx.principal,
    openTx.loanOffering.rates.interestRate,
    openTx.loanOffering.maxDuration
  );
  return interest;
}

async function getOwedAmountForTime(
  timeDiff,
  interestPeriod,
  interestRate,
  amount,
  roundUpToPeriod = true
) {
  if (interestPeriod.gt(1)) {
    timeDiff = getPartialAmount(
      timeDiff, interestPeriod, 1, roundUpToPeriod).times(interestPeriod);
  }

  await TestInterestImpl.link('InterestImpl', InterestImpl.address);
  const interestCalc = await TestInterestImpl.new();
  const owedAmount = await interestCalc.getCompoundedInterest.call(
    amount,
    interestRate,
    timeDiff
  );
  return owedAmount;
}

function getTokenAmountsFromOpen(openTx) {
  let soldAmount = openTx.principal;
  if (!openTx.depositInHeldToken) {
    soldAmount = soldAmount.plus(openTx.depositAmount)
  }
  const expectedHeldTokenFromSell = getPartialAmount(
    soldAmount,
    openTx.buyOrder.takerTokenAmount,
    openTx.buyOrder.makerTokenAmount
  );

  const expectedHeldTokenBalance = openTx.depositInHeldToken ?
    expectedHeldTokenFromSell.plus(openTx.depositAmount)
    : expectedHeldTokenFromSell;

  return {
    soldAmount,
    expectedHeldTokenFromSell,
    expectedHeldTokenBalance
  };
}

async function issueTokenToAccountInAmountAndApproveProxy(token, account, amount) {
  await issueAndSetAllowance(
    token,
    account,
    amount,
    TokenProxy.address
  );
}

module.exports = {
  createOpenTx,
  getMinimumDeposit,
  issueTokensAndSetAllowances,
  callOpenPosition,
  doOpenPosition,
  doClosePosition,
  issueTokensAndSetAllowancesForClose,
  callCancelLoanOffer,
  callClosePosition,
  callClosePositionDirectly,
  callCloseWithoutCounterparty,
  getPosition,
  doOpenPositionAndCall,
  issueForDirectClose,
  issueTokenToAccountInAmountAndApproveProxy,
  getMaxInterestFee,
  callIncreasePosition,
  getTokenAmountsFromOpen,
  orderToBytes
};
