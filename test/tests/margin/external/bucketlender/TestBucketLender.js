const chai = require('chai');
const expect = chai.expect;
chai.use(require('chai-bignumber')());
const Web3 = require('web3');
const BigNumber = require('bignumber.js');

const Margin = artifacts.require("Margin");
const HeldToken = artifacts.require("TokenA");
const OwedToken = artifacts.require("TokenB");
const TestToken = artifacts.require("TokenC");
const TestBucketLender = artifacts.require("TestBucketLender");
const TestLoanOwner = artifacts.require("TestLoanOwner");
const TestMarginCallDelegator = artifacts.require("TestMarginCallDelegator");
const ERC20ShortFactory = artifacts.require("ERC20ShortFactory");
const OpenDirectlyExchangeWrapper = artifacts.require("OpenDirectlyExchangeWrapper");

const { transact } = require('../../../../helpers/ContractHelper');
const {
  ADDRESSES,
  BIGNUMBERS,
  BYTES,
  BYTES32,
  ORDER_TYPE
} = require('../../../../helpers/Constants');
const { expectThrow } = require('../../../../helpers/ExpectHelper');
const { issueAndSetAllowance } = require('../../../../helpers/TokenHelper');
const { signLoanOffering } = require('../../../../helpers/LoanHelper');
const {
  issueTokenToAccountInAmountAndApproveProxy,
  issueTokensAndSetAllowances,
  callIncreasePosition,
  callOpenPosition,
  createOpenTx,
} = require('../../../../helpers/MarginHelper');
const { wait } = require('@digix/tempo')(web3);

let OT = new BigNumber('1234567898765543211');

const web3Instance = new Web3(web3.currentProvider);

const INTEREST_PERIOD = new BigNumber(60 * 60);
const INTEREST_RATE = new BigNumber(10 * 1000000);
const MAX_DURATION = new BigNumber(60 * 60 * 24 * 365);
const CALL_TIMELIMIT = new BigNumber(60 * 60 * 24);
const BUCKET_TIME = new BigNumber(60 * 60 * 24);
let POSITION_ID, NONCE;

let testLoanOwner, testMarginCallDelegator;
let margin, heldToken, owedToken;
let bucketLender;
let TRUSTED_PARTY, TRUSTED_WITHDRAWER, lender1, lender2, uselessLender, trader, alice;

// grants tokens to a lender and has them deposit them into the bucket lender
async function doDeposit(account, amount) {
  await bucketLender.checkInvariants();
  await issueAndSetAllowance(owedToken, account, amount, bucketLender.address);
  const tx = await transact(bucketLender.deposit, account, amount, { from: account });
  await bucketLender.checkInvariants();
  return tx.result;
}

// withdraws for a bucket from an account
async function doWithdraw(account, bucket, args) {
  args = args || {};
  args.throws = args.throws || false;
  args.weight = args.weight || BIGNUMBERS.MAX_UINT256;
  args.onBehalfOf = args.onBehalfOf || account;
  await bucketLender.checkInvariants();

  if (args.throws) {
    await expectThrow(
      bucketLender.withdraw(
        [bucket],
        [args.weight],
        args.onBehalfOf,
        { from: account }
      )
    );
    return;
  }

  const[owed0, held0] = await Promise.all([
    owedToken.balanceOf.call(account),
    heldToken.balanceOf.call(account),
  ]);

  const tx = await transact(
    bucketLender.withdraw,
    [bucket],
    [args.weight],
    args.onBehalfOf,
    { from: account }
  );

  const [owedWithdrawn, heldWithdrawn] = tx.result;
  const[owed1, held1] = await Promise.all([
    owedToken.balanceOf.call(account),
    heldToken.balanceOf.call(account),
  ]);
  expect(owed1.minus(owed0)).to.be.bignumber.eq(owedWithdrawn);
  expect(held1.minus(held0)).to.be.bignumber.eq(heldWithdrawn);

  const remainingWeight = await bucketLender.weightForBucketForAccount.call(bucket, account);
  await bucketLender.checkInvariants();
  return {owedWithdrawn, heldWithdrawn, remainingWeight};
}

async function doIncrease(amount, args) {
  args = args || {};
  args.throws = args.throws || false;
  await bucketLender.checkInvariants();

  const incrTx = createIncreaseTx(trader, amount);

  if (args.throws) {
    await expectThrow(
      callIncreasePosition(margin, incrTx)
    );
    return;
  }

  await callIncreasePosition(margin, incrTx);
  await bucketLender.checkInvariants();
}

async function doClose(amount, args) {
  args = args || {};
  args.closer = args.closer || trader;
  await bucketLender.checkInvariants();

  await margin.closePositionDirectly(
    POSITION_ID,
    amount,
    args.closer,
    { from: args.closer }
  );
  await bucketLender.checkInvariants();
}

async function runAliceBot(expectThrow = false) {
  const aliceAmount = OT;
  await bucketLender.checkInvariants();
  await issueAndSetAllowance(owedToken, alice, aliceAmount, bucketLender.address);

  if (expectThrow) {
    await expectThrow(bucketLender.deposit(alice, aliceAmount, { from: alice }));
    return;
  }

  const bucket = await transact(bucketLender.deposit, alice, aliceAmount, { from: alice });
  const { owedWithdrawn, heldWithdrawn, remainingWeight } = await doWithdraw(alice, bucket.result);
  expect(owedWithdrawn).to.be.bignumber.lte(aliceAmount);
  expect(owedWithdrawn.plus(1)).to.bignumber.gte(aliceAmount);
  expect(heldWithdrawn).to.be.bignumber.eq(0);
  expect(remainingWeight).to.be.bignumber.eq(0);
  await bucketLender.checkInvariants();
}

async function giveAPositionTo(contract, accounts) {
  let openTx = await createOpenTx(accounts);
  openTx.loanOffering.owner = contract.address;
  openTx.loanOffering.signature = await signLoanOffering(openTx.loanOffering);
  await issueTokensAndSetAllowances(openTx);
  openTx = await callOpenPosition(margin, openTx);
  return openTx.id;
}

async function setUpPosition(accounts, openThePosition = true) {
  [
    TRUSTED_PARTY,
    TRUSTED_WITHDRAWER,
    lender1,
    lender2,
    uselessLender,
    trader,
    alice
  ] = [
    accounts[0],
    accounts[4],
    accounts[5],
    accounts[6],
    accounts[7],
    accounts[8],
    accounts[9],
  ];

  NONCE = Math.floor(Math.random() * 12983748912748);
  POSITION_ID = web3Instance.utils.soliditySha3(TRUSTED_PARTY, NONCE);

  const principal = OT.times(2);
  const deposit = OT.times(6);

  bucketLender = await TestBucketLender.new(
    Margin.address,
    POSITION_ID,
    heldToken.address,
    owedToken.address,
    [
      BUCKET_TIME,
      INTEREST_RATE,
      INTEREST_PERIOD,
      MAX_DURATION,
      CALL_TIMELIMIT,
      3,
      1
    ],
    [TRUSTED_PARTY], // trusted margin-callers
    [TRUSTED_WITHDRAWER]
  );

  await Promise.all([
    issueTokenToAccountInAmountAndApproveProxy(owedToken, TRUSTED_PARTY, OT.times(1000)),
    issueTokenToAccountInAmountAndApproveProxy(heldToken, TRUSTED_PARTY, deposit),
    doDeposit(lender1, OT.times(2)),
    doDeposit(lender2, OT.times(3)),
    issueTokenToAccountInAmountAndApproveProxy(heldToken, trader, OT.times(1000)),
    issueTokenToAccountInAmountAndApproveProxy(owedToken, trader, OT.times(1000)),
  ]);

  [testLoanOwner, testMarginCallDelegator] = await Promise.all([
    TestLoanOwner.new(
      Margin.address,
      bucketLender.address,
      bucketLender.address
    ),
    TestMarginCallDelegator.new(
      Margin.address,
      TRUSTED_PARTY,
      TRUSTED_PARTY,
    ),
  ]);

  if (!openThePosition) {
    return;
  }

  await margin.openWithoutCounterparty(
    [
      ERC20ShortFactory.address,
      owedToken.address,
      heldToken.address,
      bucketLender.address
    ],
    [
      principal,
      deposit,
      NONCE
    ],
    [
      CALL_TIMELIMIT,
      MAX_DURATION,
      INTEREST_RATE,
      INTEREST_PERIOD
    ],
    { from: TRUSTED_PARTY }
  );
  await bucketLender.checkInvariants();
}

contract('BucketLender', accounts => {

  // ============ Before/After ============

  beforeEach('set up contracts', async () => {
    [
      margin,
      heldToken,
      owedToken
    ] = await Promise.all([
      Margin.deployed(),
      HeldToken.new(),
      OwedToken.new(),
    ]);

    await setUpPosition(accounts);
  });

  afterEach('make checks', async () => {
    await bucketLender.checkInvariants();
  });

  // ============ Constructor ============

  describe('Constructor', () => {
    it('sets constants correctly', async () => {
      await setUpPosition(accounts, false);
      const [
        c_margin,
        c_owedToken,
        c_heldToken,
        c_bucketTime,
        c_positionId,
        c_isTrusted,
        c_isTrusted2,

        c_wasForceClosed,
        c_criticalBucket,
        c_cachedRepaidAmount,

        c_available,
        c_available2,
        c_available3,
        c_principal,
        c_principal2,
        c_weight,
        c_weight2,

        principal,

        bucketLenderOwedToken,
        bucketLenderHeldToken,
      ] = await Promise.all([
        bucketLender.deta_MARGIN.call(),
        bucketLender.OWED_TOKEN.call(),
        bucketLender.HELD_TOKEN.call(),
        bucketLender.BUCKET_TIME.call(),
        bucketLender.POSITION_ID.call(),
        bucketLender.TRUSTED_MARGIN_CALLERS.call(accounts[0]),
        bucketLender.TRUSTED_MARGIN_CALLERS.call(accounts[1]),

        bucketLender.wasForceClosed.call(),
        bucketLender.criticalBucket.call(),
        bucketLender.cachedRepaidAmount.call(),

        bucketLender.availableTotal.call(),
        bucketLender.availableForBucket.call(0),
        bucketLender.availableForBucket.call(1),
        bucketLender.principalTotal.call(),
        bucketLender.principalForBucket.call(0),
        bucketLender.weightForBucket.call(0),
        bucketLender.weightForBucketForAccount.call(0, accounts[0]),

        margin.getPositionPrincipal.call(POSITION_ID),

        owedToken.balanceOf.call(bucketLender.address),
        heldToken.balanceOf.call(bucketLender.address),
      ]);

      expect(c_margin).to.eq(Margin.address);
      expect(c_owedToken).to.eq(owedToken.address);
      expect(c_heldToken).to.eq(heldToken.address);
      expect(c_bucketTime).to.be.bignumber.eq(BUCKET_TIME);
      expect(c_positionId).to.eq(POSITION_ID);
      expect(c_isTrusted).to.be.true;
      expect(c_isTrusted2).to.be.false;

      expect(c_wasForceClosed).to.be.false;
      expect(c_criticalBucket).to.be.bignumber.eq(0);
      expect(c_cachedRepaidAmount).to.be.bignumber.eq(0);

      expect(c_available).to.be.bignumber.eq(bucketLenderOwedToken);
      expect(c_available2).to.be.bignumber.eq(c_available);
      expect(c_available3).to.be.bignumber.eq(0);
      expect(c_principal).to.be.bignumber.eq(principal);
      expect(c_principal).to.be.bignumber.eq(c_principal2);
      expect(c_weight).to.be.bignumber.eq(principal.plus(c_available));
      expect(c_weight2).to.be.bignumber.eq(c_principal);

      expect(bucketLenderHeldToken).to.be.bignumber.eq(0);
    });

    it('does not allow zero BUCKET_TIME', async () => {
      await expectThrow(
        TestBucketLender.new(
          Margin.address,
          POSITION_ID,
          heldToken.address,
          owedToken.address,
          [
            0, // BUCKET_TIME
            INTEREST_RATE,
            INTEREST_PERIOD,
            MAX_DURATION,
            CALL_TIMELIMIT,
            3,
            1
          ],
          [],
          []
        )
      );
    });
  });

  // ============ Margin-Only State-Changing Functions ============

  describe('#verifyLoanOffering', () => {
    it('prevents lending to other positions', async () => {
      const tempId = POSITION_ID;
      await setUpPosition(accounts);
      let tx = createIncreaseTx(trader, OT);
      tx.id = tempId;
      await expectThrow(callIncreasePosition(margin, tx));
    });

    it('prevents opening a position', async () => {
      await setUpPosition(accounts, false);
      await expectThrow(
        margin.openPosition(
          [
            ERC20ShortFactory.address,
            owedToken.address,
            heldToken.address,
            bucketLender.address,
            bucketLender.address,
            ADDRESSES.ZERO,
            ADDRESSES.ZERO,
            ADDRESSES.ZERO,
            ADDRESSES.ZERO,
            ADDRESSES.ZERO,
            OpenDirectlyExchangeWrapper.address,
          ],
          [
            BIGNUMBERS.MAX_UINT256,
            BIGNUMBERS.ZERO,
            BIGNUMBERS.ZERO,
            BIGNUMBERS.ZERO,
            BIGNUMBERS.ZERO,
            BIGNUMBERS.MAX_UINT256,
            BIGNUMBERS.ZERO,
            OT,
            OT.times(3),
            NONCE
          ],
          [
            BIGNUMBERS.MAX_UINT32,
            BIGNUMBERS.MAX_UINT32,
            INTEREST_RATE,
            INTEREST_PERIOD
          ],
          true,
          BYTES.EMPTY,
          BYTES.EMPTY
        )
      );
    });

    it('prevents different addresses', async () => {
      let incrTx;

      // works once
      incrTx = createIncreaseTx(trader, OT);
      await callIncreasePosition(margin, incrTx);

      // taker
      incrTx = createIncreaseTx(trader, OT);
      incrTx.loanOffering.taker = incrTx.trader;
      await expectThrow(
        callIncreasePosition(margin, incrTx)
      );

      // feeRecipient
      incrTx = createIncreaseTx(trader, OT);
      incrTx.loanOffering.feeRecipient = alice;
      await expectThrow(
        callIncreasePosition(margin, incrTx)
      );

      // positionOwner
      const erc20contract = await margin.getPositionOwner.call(POSITION_ID);
      incrTx = createIncreaseTx(trader, OT);
      incrTx.loanOffering.positionOwner = erc20contract;
      await expectThrow(
        callIncreasePosition(margin, incrTx)
      );

      // lenderFeeToken
      incrTx = createIncreaseTx(trader, OT);
      incrTx.loanOffering.lenderFeeTokenAddress = heldToken.address;
      await expectThrow(
        callIncreasePosition(margin, incrTx)
      );

      // takerFeeToken
      incrTx = createIncreaseTx(trader, OT);
      incrTx.loanOffering.takerFeeTokenAddress = heldToken.address;
      await expectThrow(
        callIncreasePosition(margin, incrTx)
      );

      // works again
      incrTx = createIncreaseTx(trader, OT);
      await callIncreasePosition(margin, incrTx);
    });

    it('prevents different values', async () => {
      await wait(2);
      let incrTx;

      // works once
      incrTx = createIncreaseTx(trader, OT);
      await callIncreasePosition(margin, incrTx);

      // maxAmount
      incrTx = createIncreaseTx(trader, OT);
      incrTx.loanOffering.rates.maxAmount = OT.times(1000);
      await expectThrow(
        callIncreasePosition(margin, incrTx)
      );

      // minAmount
      incrTx = createIncreaseTx(trader, OT);
      incrTx.loanOffering.rates.minAmount = new BigNumber(1);
      await expectThrow(
        callIncreasePosition(margin, incrTx)
      );

      // minHeldToken
      incrTx = createIncreaseTx(trader, OT);
      incrTx.loanOffering.rates.minHeldToken = new BigNumber(1);
      await expectThrow(
        callIncreasePosition(margin, incrTx)
      );

      // lenderFee
      incrTx = createIncreaseTx(trader, OT);
      incrTx.loanOffering.rates.lenderFee = new BigNumber(1);
      await expectThrow(
        callIncreasePosition(margin, incrTx)
      );

      // takerFee
      incrTx = createIncreaseTx(trader, OT);
      incrTx.loanOffering.rates.takerFee = new BigNumber(1);
      await expectThrow(
        callIncreasePosition(margin, incrTx)
      );

      // expirationTimestamp
      incrTx = createIncreaseTx(trader, OT);
      incrTx.loanOffering.expirationTimestamp = BIGNUMBERS.MAX_UINT256.minus(1);
      await expectThrow(
        callIncreasePosition(margin, incrTx)
      );

      // salt
      incrTx = createIncreaseTx(trader, OT);
      incrTx.loanOffering.salt = new BigNumber(1);
      await expectThrow(
        callIncreasePosition(margin, incrTx)
      );

      // maxDuration
      incrTx = createIncreaseTx(trader, OT);
      incrTx.loanOffering.maxDuration = BIGNUMBERS.MAX_UINT32.minus(1);
      await expectThrow(
        callIncreasePosition(margin, incrTx)
      );

      // callTimeLimit
      incrTx = createIncreaseTx(trader, OT);
      incrTx.loanOffering.callTimeLimit = BIGNUMBERS.MAX_UINT32.minus(1);
      await expectThrow(
        callIncreasePosition(margin, incrTx)
      );

      // works again
      incrTx = createIncreaseTx(trader, OT);
      await callIncreasePosition(margin, incrTx);
    });
  });

  describe('#receiveLoanOwnership', () => {
    const ogPrincipal = OT.times(2);
    const ogDeposit = OT.times(6);

    async function openWithoutCounterpartyForBucketLender(args) {
      args = args || {};
      args.owner = args.owner || ERC20ShortFactory.address;
      args.owedToken = args.owedToken || owedToken.address;
      args.heldToken = args.heldToken || heldToken.address;
      args.lender = args.lender || bucketLender.address;
      args.principal = args.principal || ogPrincipal;
      args.deposit = args.deposit || ogDeposit;
      args.nonce = args.nonce || NONCE;
      args.callTimeLimit = args.callTimeLimit || CALL_TIMELIMIT;
      args.maxDuration = args.maxDuration || MAX_DURATION;
      args.interestRate = args.interestRate || INTEREST_RATE;
      args.interestPeriod = args.interestPeriod || INTEREST_PERIOD;
      const promise = margin.openWithoutCounterparty(
        [
          args.owner,
          args.owedToken,
          args.heldToken,
          args.lender
        ],
        [
          args.principal,
          args.deposit,
          args.nonce
        ],
        [
          args.callTimeLimit,
          args.maxDuration,
          args.interestRate,
          args.interestPeriod
        ]
      );
      if (args.throws) {
        await expectThrow(promise);
      } else {
        await Promise.all([promise]);
      }
    }

    it('succeeds under normal conditions', async () => {
      await setUpPosition(accounts);
      const owner = await margin.getPositionLender.call(POSITION_ID);
      expect(owner).to.be.equal(bucketLender.address);
    });

    it('fails for the wrong heldToken', async () => {
      await setUpPosition(accounts, false);
      const badToken = await HeldToken.new();
      await issueTokenToAccountInAmountAndApproveProxy(badToken, accounts[0], OT.times(1000)),
      await openWithoutCounterpartyForBucketLender({ throws: true, heldToken: badToken.address });
    });

    it('fails for the wrong owedToken', async () => {
      await setUpPosition(accounts, false);
      const badToken = await OwedToken.new();
      await openWithoutCounterpartyForBucketLender({ throws: true, owedToken: badToken.address });
    });

    it('fails for the wrong maxDuration', async () => {
      await setUpPosition(accounts, false);
      const maxDuration = BIGNUMBERS.MAX_UINT32.minus(2);
      await openWithoutCounterpartyForBucketLender({ throws: true, maxDuration: maxDuration });
    });

    it('fails for the wrong callTimeLimit', async () => {
      await setUpPosition(accounts, false);
      const callTimeLimit = BIGNUMBERS.MAX_UINT32.minus(2);
      await openWithoutCounterpartyForBucketLender({ throws: true, callTimeLimit: callTimeLimit });
    });

    it('fails for the wrong interestRate', async () => {
      await setUpPosition(accounts, false);
      const interestRate = INTEREST_RATE.add(1);
      await openWithoutCounterpartyForBucketLender({ throws: true, interestRate: interestRate });
    });

    it('fails for the wrong interestPeriod', async () => {
      await setUpPosition(accounts, false);
      const interestPeriod = INTEREST_RATE.add(1);
      await openWithoutCounterpartyForBucketLender(
        { throws: true, interestPeriod: interestPeriod }
      );
    });

    it('fails for insufficient collateral', async () => {
      await setUpPosition(accounts, false);
      await openWithoutCounterpartyForBucketLender(
        { throws: true, principal: ogPrincipal.plus(1) }
      );
    });

    it('fails for the wrong position ID during open', async () => {
      await expectThrow(giveAPositionTo(testLoanOwner, accounts));
    });

    it('fails for the wrong position ID during transfer', async () => {
      await setUpPosition(accounts, false);
      const openTx = await createOpenTx(accounts, { nonce: NONCE });
      await issueTokensAndSetAllowances(openTx);
      await callOpenPosition(margin, openTx);
      const lender = openTx.loanOffering.owner;
      await margin.transferLoan(POSITION_ID, accounts[9], { from: lender });
    });
  });

  describe('#increaseLoanOnBehalfOf', () => {
    it('succeeds under normal conditions', async () => {
      await doIncrease(OT);
    });

    it('fails for the wrong position ID', async () => {
      await testLoanOwner.setToReturn(ADDRESSES.ONE);
      const positionId = await giveAPositionTo(testLoanOwner, accounts);

      const incrTx = await createOpenTx(accounts);
      incrTx.loanOffering.owner = testLoanOwner.address;
      incrTx.loanOffering.rates.minHeldToken = new BigNumber(0);
      incrTx.loanOffering.signature = await signLoanOffering(incrTx.loanOffering);
      await issueTokensAndSetAllowances(incrTx);
      incrTx.id = positionId;
      incrTx.principal = incrTx.principal.div(2).floor();
      await issueTokenToAccountInAmountAndApproveProxy(
        heldToken,
        incrTx.trader,
        incrTx.depositAmount.times(4)
      );
      await expectThrow(callIncreasePosition(margin, incrTx));
    });

    it('prevents other lenders from lending for this position', async () => {
      let tx = createIncreaseTx(trader, OT);
      tx.loanOffering.payer = uselessLender;
      tx.loanOffering.signature = await signLoanOffering(tx.loanOffering);
      await issueTokenToAccountInAmountAndApproveProxy(owedToken, uselessLender, OT.times(2));
      await expectThrow(callIncreasePosition(margin, tx));
    });

    it('prevents lending while the position is margin-called', async () => {
      const principal = OT.times(2);
      const deposit = OT.times(6);
      await setUpPosition(accounts, false);
      await margin.openWithoutCounterparty(
        [
          trader,
          owedToken.address,
          heldToken.address,
          bucketLender.address
        ],
        [
          principal,
          deposit,
          NONCE
        ],
        [
          CALL_TIMELIMIT,
          MAX_DURATION,
          INTEREST_RATE,
          INTEREST_PERIOD
        ],
        { from: TRUSTED_PARTY }
      );
      await margin.marginCall(POSITION_ID, 0);
      let tx = createIncreaseTx(trader, OT);
      await expectThrow(callIncreasePosition(margin, tx));
    });

    it('prevents lending of non-accounted-for-funds', async () => {
      const largeAmount = OT.times(10);
      await owedToken.issueTo(bucketLender.address, largeAmount);
      let tx = createIncreaseTx(trader, largeAmount);
      await expectThrow(callIncreasePosition(margin, tx));
    });
  });

  describe('#marginCallOnBehalfOf', () => {
    it('succeeds under normal conditions', async () => {
      await margin.marginCall(POSITION_ID, 0, { from: TRUSTED_PARTY });
      const isCalled = await margin.isPositionCalled.call(POSITION_ID);
      expect(isCalled).to.be.true;
    });

    it('fails for non-zero deposit', async () => {
      await expectThrow(
        margin.marginCall(POSITION_ID, 1, { from: TRUSTED_PARTY })
      );
    });

    it('fails for the wrong position ID', async () => {
      const id = await giveAPositionTo(testMarginCallDelegator, accounts);
      await testMarginCallDelegator.setToReturn(bucketLender.address);
      await expectThrow(
        margin.marginCall(id, 0, { from: TRUSTED_PARTY })
      );
    });

    it('fails for an unauthorized account', async () => {
      await expectThrow(
        margin.marginCall(POSITION_ID, 0, { from: uselessLender })
      );
    });
  });

  describe('#cancelMarginCallOnBehalfOf', () => {
    beforeEach('margin-call the position', async () => {
      await margin.marginCall(POSITION_ID, 0, { from: TRUSTED_PARTY });
      const isCalled = await margin.isPositionCalled.call(POSITION_ID);
      expect(isCalled).to.be.true;
      await wait(1);
    });

    it('succeeds under normal conditions', async () => {
      await margin.cancelMarginCall(POSITION_ID, { from: TRUSTED_PARTY });
      const isCalled = await margin.isPositionCalled.call(POSITION_ID);
      expect(isCalled).to.be.false;
    });

    it('fails for an unauthorized account', async () => {
      await expectThrow(
        margin.cancelMarginCall(POSITION_ID, { from: uselessLender })
      );
    });

    it('fails for the wrong position ID', async () => {
      const id = await giveAPositionTo(testMarginCallDelegator, accounts);
      await margin.marginCall(id, 0, { from: TRUSTED_PARTY });
      await testMarginCallDelegator.setToReturn(bucketLender.address);
      await expectThrow(
        margin.cancelMarginCall(id, { from: TRUSTED_PARTY })
      );
    });
  });

  describe('#forceRecoverCollateralOnBehalfOf', () => {
    beforeEach('margin-call the position', async () => {
      await margin.marginCall(POSITION_ID, 0, { from: TRUSTED_PARTY });
      await wait(MAX_DURATION.toNumber());
    });

    it('succeeds under normal conditions', async () => {
      await margin.forceRecoverCollateral(
        POSITION_ID,
        bucketLender.address,
        { from: TRUSTED_PARTY }
      );
      const closed = await margin.isPositionClosed.call(POSITION_ID);
      expect(closed).to.be.true;
    });

    it('fails for the wrong recipient', async () => {
      await expectThrow(
        margin.forceRecoverCollateral(
          POSITION_ID,
          TRUSTED_PARTY,
          { from: TRUSTED_PARTY }
        )
      );
    });

    it('fails for the wrong position ID', async () => {
      const id = await giveAPositionTo(testMarginCallDelegator, accounts);
      await margin.marginCall(id, 0, { from: TRUSTED_PARTY });
      await testMarginCallDelegator.setToReturn(bucketLender.address);
      await expectThrow(
        margin.forceRecoverCollateral(
          id,
          bucketLender.address,
          { from: TRUSTED_PARTY }
        )
      );
    });
  });

  // ============ Public State-Changing Functions ============

  describe('#deposit', () => {
    it('succeeds before the position is opened', async () => {
      let bucket, weight;
      await setUpPosition(accounts, false);
      bucket = await doDeposit(alice, OT);
      expect(bucket).to.be.bignumber.eq(0);
      weight = await bucketLender.weightForBucketForAccount.call(bucket, alice);
      expect(weight).to.be.bignumber.eq(OT);
    });

    it('succeeds after the position is opened', async () => {
      let bucket, weight;
      bucket = await doDeposit(lender1, OT);
      expect(bucket).to.be.bignumber.eq(1);
      weight = await bucketLender.weightForBucket.call(bucket);
      expect(weight).to.be.bignumber.eq(OT);
      weight = await bucketLender.weightForBucketForAccount.call(bucket, lender1);
      expect(weight).to.be.bignumber.eq(OT);

      await wait(BUCKET_TIME.toNumber());

      bucket = await doDeposit(lender1, OT);
      expect(bucket).to.be.bignumber.eq(2);
      weight = await bucketLender.weightForBucket.call(bucket);
      expect(weight).to.be.bignumber.eq(OT);
      weight = await bucketLender.weightForBucketForAccount.call(bucket, lender1);
      expect(weight).to.be.bignumber.eq(OT);
    });

    it('gives less weight for buckets that have already earned interest', async () => {
      let bucket, weight;
      await doDeposit(lender1, OT);
      await doIncrease(OT.times(6));

      await wait(60 * 60 * 12);

      bucket = await doDeposit(lender2, OT);
      expect(bucket).to.be.bignumber.eq(1);
      weight = await bucketLender.weightForBucket.call(bucket);
      expect(weight).to.be.bignumber.lt(OT.times(2));
      weight = await bucketLender.weightForBucketForAccount.call(bucket, lender2);
      expect(weight).to.be.bignumber.lt(OT);
      expect(weight).to.be.bignumber.gt(0);
    });

    it('fails for zero weight', async () => {
      let bucket, weight;
      await doDeposit(lender1, OT);
      await doIncrease(OT.times(6));
      await wait(60 * 60 * 12);

      bucket = await doDeposit(lender2, 2);
      expect(bucket).to.be.bignumber.eq(1);
      weight = await bucketLender.weightForBucketForAccount.call(bucket, lender2);
      expect(weight).to.be.bignumber.eq(1);

      // throw for depositing 1 token (zero weight)
      await expectThrow(doDeposit(lender2, 1));
    });

    it('fails for zero deposit', async () => {
      await expectThrow(
        doDeposit(lender1, BIGNUMBERS.ZERO)
      );
    });

    it('fails for zero address', async () => {
      await issueAndSetAllowance(owedToken, lender1, OT, bucketLender.address);
      await expectThrow(
        bucketLender.deposit(ADDRESSES.ZERO, OT, { from: lender1 })
      );
    });

    it('fails if position is margin-called', async () => {
      await margin.marginCall(POSITION_ID, 0, { from: TRUSTED_PARTY });
      await expectThrow(
        doDeposit(lender1, OT)
      );
    });

    it('fails if position is closed for force-close', async () => {
      await margin.marginCall(POSITION_ID, 0, { from: TRUSTED_PARTY });
      await wait(MAX_DURATION.toNumber());
      await margin.forceRecoverCollateral(
        POSITION_ID,
        bucketLender.address,
        { from: TRUSTED_PARTY }
      );
      await expectThrow(
        doDeposit(lender1, OT)
      );
    });

    it('fails if position is closed from full-close', async () => {
      await issueTokenToAccountInAmountAndApproveProxy(owedToken, TRUSTED_PARTY, OT.times(1000));
      await margin.closePositionDirectly(
        POSITION_ID,
        BIGNUMBERS.MAX_UINT256,
        TRUSTED_PARTY,
        { from: TRUSTED_PARTY }
      );
      await expectThrow(
        doDeposit(lender1, OT)
      );
    });
  });

  describe('#withdrawExcessToken', () => {
    const reciever = accounts[9];
    const amount = new BigNumber("1123498756213");

    async function doWithdrawExtra(token, toExpect) {
      const [bl0, rc0] = await Promise.all([
        token.balanceOf.call(bucketLender.address),
        token.balanceOf.call(reciever)
      ]);
      const moved = await transact(bucketLender.withdrawExcessToken, token.address, reciever);
      const [bl1, rc1] = await Promise.all([
        token.balanceOf.call(bucketLender.address),
        token.balanceOf.call(reciever)
      ]);
      expect(moved.result).to.be.bignumber.eq(toExpect);
      expect(bl0.sub(bl1)).to.be.bignumber.eq(toExpect);
      expect(rc1.sub(rc0)).to.be.bignumber.eq(toExpect);
    }

    it('succeeds after rebalance for owedToken', async () => {
      await owedToken.issueTo(bucketLender.address, amount);
      await doDeposit(uselessLender, amount);
      await doWithdrawExtra(owedToken, amount);

      await owedToken.issueTo(bucketLender.address, amount);
      await doDeposit(uselessLender, amount);
      await doWithdrawExtra(owedToken, amount);

      await doIncrease(amount);
      await owedToken.issueTo(bucketLender.address, amount);
      await doWithdrawExtra(owedToken, amount);

      await owedToken.issueTo(bucketLender.address, amount);
      await doIncrease(amount);
      await doWithdrawExtra(owedToken, amount);

      await owedToken.issueTo(bucketLender.address, amount);
      await doClose(amount);
      await bucketLender.rebalanceBuckets();
      await doWithdrawExtra(owedToken, amount);

      await owedToken.issueTo(bucketLender.address, amount);
      await doClose(amount);
      await owedToken.issueTo(bucketLender.address, amount);
      await bucketLender.rebalanceBuckets();
      await doWithdrawExtra(owedToken, amount.times(2));

      await owedToken.issueTo(bucketLender.address, amount);
      await doWithdrawExtra(owedToken, amount);
    });

    it('succeeds before rebalance for owedToken', async () => {
      await doIncrease(amount);
      await owedToken.issueTo(bucketLender.address, amount);
      await doClose(amount);
      await owedToken.issueTo(bucketLender.address, amount);
      await doWithdrawExtra(owedToken, amount.times(2));
    });

    it('succeeds for heldToken', async () => {
      // succeeds while open
      await heldToken.issueTo(bucketLender.address, amount);
      await doWithdrawExtra(heldToken, amount);

      // succeeds after close
      await heldToken.issueTo(bucketLender.address, amount);
      await doClose(BIGNUMBERS.MAX_UINT256, { closer: TRUSTED_PARTY });
      await doWithdrawExtra(heldToken, amount);
    });

    it('fails after force-close for heldToken', async () => {
      await heldToken.issueTo(bucketLender.address, amount);

      // force-close it
      await margin.marginCall(POSITION_ID, 0, { from: TRUSTED_PARTY });
      await wait(MAX_DURATION.toNumber());
      await margin.forceRecoverCollateral(
        POSITION_ID,
        bucketLender.address,
        { from: TRUSTED_PARTY }
      );

      await expectThrow(bucketLender.withdrawExcessToken(heldToken.address, reciever));
    });

    it('succeeds for random token', async () => {
      const randomToken = await TestToken.new();
      await randomToken.issueTo(bucketLender.address, amount);
      await doWithdrawExtra(randomToken, amount);
    });
  });
});

contract('BucketLender', accounts => {

  // ============ Before/After ============

  beforeEach('set up contracts', async () => {
    [
      margin,
      heldToken,
      owedToken
    ] = await Promise.all([
      Margin.deployed(),
      HeldToken.new(),
      OwedToken.new(),
    ]);

    await setUpPosition(accounts);
  });

  afterEach('make checks', async () => {
    await bucketLender.checkInvariants();
  });

  // ============ Withdraw ============

  describe('#withdraw', () => {
    it('Multiple deposit and withdraw', async () => {
      await runAliceBot();
      await runAliceBot();
      await runAliceBot();
    });

    it('succeeds in withdrawing from bucket 0', async () => {
      await doWithdraw(lender1, 0);
      await doWithdraw(lender1, 0, { weight: 0 });
    });

    it('succeeds for a badly-formed BucketLender', async () => {
      bucketLender = await TestBucketLender.new(
        Margin.address,
        BYTES32.ZERO,
        heldToken.address,
        owedToken.address,
        [1, 0, 0, 0, 0, 0, 0],
        [],
        []
      );
      await doDeposit(lender1, OT);
      const {owedWithdrawn, heldWithdrawn, remainingWeight} = await doWithdraw(lender1, 0);
      expect(owedWithdrawn).to.be.bignumber.eq(OT);
      expect(heldWithdrawn).to.be.bignumber.eq(0);
      expect(remainingWeight).to.be.bignumber.eq(0);
    });

    it('succeeds for withdrawing what was just put in', async () => {
      const bucket = await doDeposit(uselessLender, OT);
      expect(bucket).to.be.bignumber.not.eq(0);
      const {owedWithdrawn, heldWithdrawn, remainingWeight} =
        await doWithdraw(uselessLender, bucket);
      expect(owedWithdrawn).to.be.bignumber.eq(OT);
      expect(heldWithdrawn).to.be.bignumber.eq(0);
      expect(remainingWeight).to.be.bignumber.eq(0);
    });

    it('succeeds for withdrawing after some interest has been repaid', async () => {
      const amount = OT.times(5);
      await doIncrease(amount);
      await wait(60 * 60 * 11.5);
      await doClose(amount);

      { // lender1
        const {owedWithdrawn, heldWithdrawn, remainingWeight} =
          await doWithdraw(lender1, 0);
        expect(owedWithdrawn).to.be.bignumber.gt(OT.times(2));
        expect(heldWithdrawn).to.be.bignumber.eq(0);
        expect(remainingWeight).to.be.bignumber.eq(0);
      }

      { // lender2
        const {owedWithdrawn, heldWithdrawn, remainingWeight} =
          await doWithdraw(lender2, 0);
        expect(owedWithdrawn).to.be.bignumber.gt(OT.times(3));
        expect(heldWithdrawn).to.be.bignumber.eq(0);
        expect(remainingWeight).to.be.bignumber.eq(0);
      }
    });

    it('succeeds even when principal amount for lender is zero', async () => {
      await doDeposit(lender1, 1);
      await doDeposit(lender2, OT);

      await wait(60 * 24 * 24 * 1 + 1);

      await doIncrease(OT.times(5));

      await wait(MAX_DURATION.toNumber());
      await margin.forceRecoverCollateral(POSITION_ID, bucketLender.address);

      const result1 = await doWithdraw(lender1, 1);
      expect(result1.owedWithdrawn).to.be.bignumber.eq(0);
      expect(result1.heldWithdrawn).to.be.bignumber.eq(0);
      expect(result1.remainingWeight).to.be.bignumber.eq(0);
      const result2 = await doWithdraw(lender2, 1);
      expect(result2.owedWithdrawn).to.be.bignumber.gt(0);
      expect(result2.heldWithdrawn).to.be.bignumber.gt(0);
      expect(result2.remainingWeight).to.be.bignumber.eq(0);
    });

    it('succeeds but returns no tokens for random buckets', async () => {
      const {owedWithdrawn, heldWithdrawn, remainingWeight} = await doWithdraw(lender1, 1000);
      expect(owedWithdrawn).to.be.bignumber.eq(0);
      expect(heldWithdrawn).to.be.bignumber.eq(0);
      expect(remainingWeight).to.be.bignumber.eq(0);
    });

    it('succeeds after full-close', async () => {
      await wait(1);
      await doIncrease(OT.times(4));
      await wait(60 * 60 * 24 * 2);
      await doClose(OT.times(4));
      await doClose(BIGNUMBERS.MAX_UINT256, { closer: TRUSTED_PARTY });

      const isClosed = await margin.isPositionClosed.call(POSITION_ID);
      expect(isClosed).to.be.true;

      const {owedWithdrawn, heldWithdrawn, remainingWeight} = await doWithdraw(lender1, 0);
      expect(owedWithdrawn).to.be.bignumber.gt(OT.times(2));
      expect(heldWithdrawn).to.be.bignumber.eq(0);
      expect(remainingWeight).to.be.bignumber.eq(0);
    });

    it('succeeds after force-closing', async () => {
      await doIncrease(OT.times(4));
      await wait(MAX_DURATION.toNumber());
      await doClose(OT.times(2));
      await margin.forceRecoverCollateral(POSITION_ID, bucketLender.address);

      const ratio = 3;
      let result, weight, value;

      weight = await bucketLender.weightForBucketForAccount.call(0, lender1);
      result = await doWithdraw(lender1, 0);
      expect(result.owedWithdrawn).to.be.bignumber.gt(0);
      expect(result.heldWithdrawn).to.be.bignumber.gt(0);
      expect(result.remainingWeight).to.be.bignumber.eq(0);
      value = result.owedWithdrawn.plus(result.heldWithdrawn.div(ratio));
      expect(value).to.be.bignumber.gt(weight);

      weight = await bucketLender.weightForBucketForAccount.call(0, lender2);
      result = await doWithdraw(lender2, 0);
      expect(result.owedWithdrawn).to.be.bignumber.gt(0);
      expect(result.heldWithdrawn).to.be.bignumber.gt(0);
      expect(result.remainingWeight).to.be.bignumber.eq(0);
      value = result.owedWithdrawn.plus(result.heldWithdrawn.div(ratio));
      expect(value).to.be.bignumber.gt(weight);

      weight = await bucketLender.weightForBucketForAccount.call(0, TRUSTED_PARTY);
      result = await doWithdraw(TRUSTED_PARTY, 0);
      expect(result.owedWithdrawn).to.be.bignumber.gt(0);
      expect(result.heldWithdrawn).to.be.bignumber.gt(0);
      expect(result.remainingWeight).to.be.bignumber.eq(0);
      value = result.owedWithdrawn.plus(result.heldWithdrawn.div(ratio));
      expect(value).to.be.bignumber.gt(weight);
    });

    it('fails for not-enough available amount', async () => {
      await doIncrease(OT.times(4));
      await wait(60 * 60 * 24 * 4);

      await doWithdraw(lender1, 0, { throws: true });

      const weightToWithdraw = OT.div(2).floor();
      const startingWeight = await bucketLender.weightForBucketForAccount.call(0, lender1);
      const {owedWithdrawn, heldWithdrawn, remainingWeight} =
        await doWithdraw(lender1, 0, { weight: weightToWithdraw });
      expect(owedWithdrawn).to.be.bignumber.gte(weightToWithdraw);
      expect(heldWithdrawn).to.be.bignumber.eq(0);
      expect(remainingWeight).to.be.bignumber.eq(startingWeight.minus(weightToWithdraw));
    });

    it('succeeds but returns no tokens for the current/critical bucket', async () => {
      let bucket;
      await wait(1);

      bucket = await doDeposit(lender1, OT);
      expect(bucket).to.be.bignumber.eq(1);

      await doIncrease(OT.times(5).plus(1));

      bucket = await doDeposit(lender1, OT);
      expect(bucket).to.be.bignumber.eq(1);
      await bucketLender.rebalanceBuckets();

      const weight = await bucketLender.weightForBucketForAccount.call(1, lender1);
      const {owedWithdrawn, heldWithdrawn, remainingWeight} = await doWithdraw(lender1, 1);

      expect(owedWithdrawn).to.be.bignumber.eq(0);
      expect(heldWithdrawn).to.be.bignumber.eq(0);
      expect(remainingWeight).to.be.bignumber.eq(weight);
    });

    it('fails if the array lengths dont match', async () => {
      await expectThrow(
        bucketLender.withdraw(
          [0],
          [BIGNUMBERS.MAX_UINT256, BIGNUMBERS.MAX_UINT256],
          lender1,
          { from: lender1 }
        )
      );
      await expectThrow(
        bucketLender.withdraw(
          [0, 1],
          [BIGNUMBERS.MAX_UINT256],
          lender1,
          { from: lender1 }
        )
      );
    });

    it('succeeds for trusted withdrawer', async () => {
      await doWithdraw(TRUSTED_WITHDRAWER, 0, { onBehalfOf: lender1 });
    });

    it('fails for non-trusted withdrawer', async () => {
      await doWithdraw(TRUSTED_PARTY, 0, { onBehalfOf: lender1, throws: true});
    });
  });

  describe('#rebalanceBuckets', () => {
    async function getAmounts() {
      const [
        principalTotal,
        principal0,
        principal1,
        availableTotal,
        available0,
        available1,
      ] = await Promise.all([
        bucketLender.principalTotal.call(),
        bucketLender.principalForBucket.call(0),
        bucketLender.principalForBucket.call(1),
        bucketLender.availableTotal.call(),
        bucketLender.availableForBucket.call(0),
        bucketLender.availableForBucket.call(1),
      ]);

      expect(principalTotal).to.be.bignumber.eq(principal0.plus(principal1));
      expect(availableTotal).to.be.bignumber.eq(available0.plus(available1));

      return {
        principalTotal,
        principal0,
        principal1,
        availableTotal,
        available0,
        available1,
      };
    }

    it('succeeds after close', async () => {
      let result;
      const startingPrincipal = await bucketLender.principalTotal.call();
      await wait(1);

      await doDeposit(lender1, OT.times(5));
      result = await getAmounts();
      expect(result.principal0).to.be.bignumber.eq(startingPrincipal);
      expect(result.principal1).to.be.bignumber.eq(0);
      expect(result.available0).to.be.bignumber.eq(OT.times(5));
      expect(result.available1).to.be.bignumber.eq(OT.times(5));

      await doIncrease(OT.times(8));
      result = await getAmounts();
      expect(result.principal0).to.be.bignumber.eq(startingPrincipal.plus(OT.times(5)));
      expect(result.principal1).to.be.bignumber.eq(OT.times(3));
      expect(result.available0).to.be.bignumber.eq(0);
      expect(result.available1).to.be.bignumber.eq(OT.times(2));

      await wait(60 * 60 * 24 * 2);

      await doClose(OT.times(5));
      result = await getAmounts();
      expect(result.principal0).to.be.bignumber.eq(startingPrincipal.plus(OT.times(5)));
      expect(result.principal1).to.be.bignumber.eq(OT.times(3));
      expect(result.available0).to.be.bignumber.eq(0);
      expect(result.available1).to.be.bignumber.eq(OT.times(2));

      await bucketLender.rebalanceBuckets();
      result = await getAmounts();
      expect(result.principal0).to.be.bignumber.eq(startingPrincipal.plus(OT.times(3)));
      expect(result.principal1).to.be.bignumber.eq(0);
      expect(result.available0).to.be.bignumber.gte(OT.times(2));
      expect(result.available1).to.be.bignumber.gte(OT.times(5));
    });

    it('does nothing after the position is force-closed', async () => {
      await doDeposit(lender1, OT.times(5));
      await doIncrease(OT.times(8));
      await wait(MAX_DURATION.toNumber());
      await doClose(OT.times(5));

      const result0 = await getAmounts();
      await margin.forceRecoverCollateral(POSITION_ID, bucketLender.address);
      const result1 = await getAmounts();
      await bucketLender.rebalanceBuckets();
      const result2 = await getAmounts();

      expect(result0.principal0).to.be.bignumber.not.eq(result1.principal0);
      expect(result0.principal1).to.be.bignumber.not.eq(result1.principal1);
      expect(result0.available0).to.be.bignumber.not.eq(result1.available0);
      expect(result0.available1).to.be.bignumber.not.eq(result1.available1);

      expect(result1.principal0).to.be.bignumber.eq(result2.principal0);
      expect(result1.principal1).to.be.bignumber.eq(result2.principal1);
      expect(result1.available0).to.be.bignumber.eq(result2.available0);
      expect(result1.available1).to.be.bignumber.eq(result2.available1);
    });

    it('does nothing when the position has not been closed since the last rebalance', async () => {
      await wait(1);
      await doDeposit(lender1, OT.times(3));
      await wait(60 * 60 * 24);
      await doIncrease(OT.times(3));
      await wait(60 * 60 * 24);
      await doClose(OT.times(2));
      await wait(60 * 60 * 24);
      await doIncrease(OT.times(3));

      const result1 = await getAmounts();
      await bucketLender.rebalanceBuckets();
      const result2 = await getAmounts();

      expect(result1.principal0).to.be.bignumber.eq(result2.principal0);
      expect(result1.principal1).to.be.bignumber.eq(result2.principal1);
      expect(result1.available0).to.be.bignumber.eq(result2.available0);
      expect(result1.available1).to.be.bignumber.eq(result2.available1);
    });
  });
});


contract('BucketLender', accounts => {

  // ============ Before/After ============

  beforeEach('set up contracts', async () => {
    [
      margin,
      heldToken,
      owedToken
    ] = await Promise.all([
      Margin.deployed(),
      HeldToken.new(),
      OwedToken.new(),
    ]);

    await setUpPosition(accounts);
  });

  afterEach('make checks', async () => {
    await bucketLender.checkInvariants();
  });

  // ============ Integration Tests ============

  describe('Integration Test', () => {
    it('Normal integration test', async () => {
      await runAliceBot();

      await doDeposit(lender1, OT.times(3));
      await runAliceBot();

      await doIncrease(OT.times(3));
      await runAliceBot();

      await wait(60 * 60 * 24 * 4);
      await runAliceBot();

      await doDeposit(uselessLender, OT.times(3));
      await runAliceBot();

      await wait(60 * 60 * 24 * 4);
      await runAliceBot();

      await doClose(OT.times(3));
      await runAliceBot();

      await bucketLender.rebalanceBuckets();
      await runAliceBot();

      await doDeposit(uselessLender, OT.times(3));
      await runAliceBot();

      await wait(60 * 60 * 24 * 1);
      await runAliceBot();

      await doIncrease(OT.times(3));
      await doIncrease(OT.times(5));
      await runAliceBot();

      // expect that the lenders can no longer withdraw their owedToken isnce it has been lent
      await expectThrow(doWithdraw(lender1, 0));
      await expectThrow(doWithdraw(lender2, 0));
      await runAliceBot();

      await wait(60 * 60 * 24 * 1);
      await runAliceBot();

      await doClose(OT.times(3));
      await runAliceBot();

      // margin-call
      await expectThrow(margin.marginCall(POSITION_ID, 0, { from: lender1 }));
      await expectThrow(margin.marginCall(POSITION_ID, 1));
      await margin.marginCall(POSITION_ID, 0);
      await bucketLender.checkInvariants();

      // can't deposit while margin-called
      await expectThrow(doDeposit(uselessLender, OT));

      // can't increase position while margin-called
      await doIncrease(OT, {throws: true});
      await bucketLender.checkInvariants();

      await wait(60 * 60 * 24 * 1);
      await bucketLender.checkInvariants();

      // cancel margin-call
      await expectThrow(margin.cancelMarginCall(POSITION_ID, { from: lender1 }));
      await margin.cancelMarginCall(POSITION_ID);
      await runAliceBot();

      // can deposit again
      await doDeposit(uselessLender, OT);
      await runAliceBot();

      // can increase again
      await doIncrease(OT.times(6));
      await runAliceBot();

      await wait(60 * 60 * 24 * 1);
      await runAliceBot();

      // margin-call again
      await expectThrow(margin.marginCall(POSITION_ID, 0, { from: lender2 }));
      await margin.marginCall(POSITION_ID, 0);

      await bucketLender.checkInvariants();

      await doClose(BIGNUMBERS.MAX_UINT256);

      await wait(60 * 60 * 24 * 1);
      await bucketLender.checkInvariants();

      //  Force-recover collateral
      await margin.forceRecoverCollateral(POSITION_ID, bucketLender.address);
      await bucketLender.checkInvariants();

      // can't deposit after position closed
      const closed = await margin.isPositionClosed(POSITION_ID);
      expect(closed).to.be.true;
      await expectThrow(doDeposit(uselessLender, OT));
      await bucketLender.checkInvariants();

      // do all remaining withdrawals
      for(let a = 0; a < 10; a++) {
        let act = accounts[a];
        for(let b = 0; b < 20; b++) {
          const hasWeight = await bucketLender.weightForBucketForAccount.call(b, act);
          if (!hasWeight.isZero()) {
            await doWithdraw(act, b);
          }
        }
      }

      // check constants
      const [
        c_wasForceClosed,
        c_criticalBucket,
        c_cachedRepaidAmount,
        actualRepaidAmount,

        c_available,
        c_available2,
        c_available3,
        c_principal,
        c_principal2,
        c_weight,
        c_weight2,

        isClosed,

        bucketLenderOwedToken,
        bucketLenderHeldToken,
      ] = await Promise.all([
        bucketLender.wasForceClosed.call(),
        bucketLender.criticalBucket.call(),
        bucketLender.cachedRepaidAmount.call(),
        margin.getTotalOwedTokenRepaidToLender.call(POSITION_ID),

        bucketLender.availableTotal.call(),
        bucketLender.availableForBucket.call(0),
        bucketLender.availableForBucket.call(1),
        bucketLender.principalTotal.call(),
        bucketLender.principalForBucket.call(0),
        bucketLender.weightForBucket.call(0),
        bucketLender.weightForBucketForAccount.call(0, accounts[0]),

        margin.isPositionClosed.call(POSITION_ID),

        owedToken.balanceOf.call(bucketLender.address),
        heldToken.balanceOf.call(bucketLender.address),
      ]);
      expect(c_wasForceClosed).to.be.true;
      expect(c_criticalBucket).to.be.bignumber.eq(0);
      expect(c_cachedRepaidAmount).to.be.bignumber.eq(actualRepaidAmount);
      expect(c_available).to.be.bignumber.eq(0);
      expect(c_available2).to.be.bignumber.eq(0);
      expect(c_available3).to.be.bignumber.eq(0);
      expect(c_principal).to.be.bignumber.eq(0);
      expect(c_principal2).to.be.bignumber.eq(0);
      expect(c_weight).to.be.bignumber.eq(0);
      expect(c_weight2).to.be.bignumber.eq(0);
      expect(isClosed).to.be.true;
      expect(bucketLenderOwedToken).to.be.bignumber.eq(0);
      expect(bucketLenderHeldToken).to.be.bignumber.eq(0);
      await bucketLender.checkInvariants();
    });

    it('Integration test where some lenders get only heldToken paid back', async () => {
      await runAliceBot();

      await doDeposit(lender1, OT.times(3));
      await runAliceBot();

      await doIncrease(OT.times(3));
      await runAliceBot();

      await wait(60 * 60 * 24 * 4);
      await runAliceBot();

      await doDeposit(uselessLender, OT.times(3));
      await runAliceBot();

      await wait(60 * 60 * 24 * 4);
      await runAliceBot();

      await doClose(OT.times(3));
      await runAliceBot();

      await bucketLender.rebalanceBuckets();
      await runAliceBot();

      await doDeposit(uselessLender, OT.times(3));
      await runAliceBot();

      await wait(60 * 60 * 24 * 1);
      await runAliceBot();

      await doIncrease(OT.times(3));
      await doIncrease(OT.times(5));
      await runAliceBot();

      // expect that the lenders can no longer withdraw their owedToken isnce it has been lent
      await expectThrow(doWithdraw(lender1, 0));
      await expectThrow(doWithdraw(lender2, 0));
      await runAliceBot();

      await wait(60 * 60 * 24 * 1);
      await runAliceBot();

      await doClose(OT.times(3));
      await runAliceBot();

      // margin-call
      await expectThrow(margin.marginCall(POSITION_ID, 0, { from: lender1 }));
      await expectThrow(margin.marginCall(POSITION_ID, 1));
      await margin.marginCall(POSITION_ID, 0);
      await bucketLender.checkInvariants();

      // can't deposit while margin-called
      await expectThrow(doDeposit(uselessLender, OT));

      // can't increase position while margin-called
      await doIncrease(OT, {throws: true});
      await bucketLender.checkInvariants();

      await wait(60 * 60 * 24 * 1);
      await bucketLender.checkInvariants();

      // cancel margin-call
      await expectThrow(margin.cancelMarginCall(POSITION_ID, { from: lender1 }));
      await margin.cancelMarginCall(POSITION_ID);
      await runAliceBot();

      // can deposit again
      await doDeposit(uselessLender, OT);
      await runAliceBot();

      // can increase again
      await doIncrease(OT.times(6));
      await runAliceBot();

      await wait(60 * 60 * 24 * 1);
      await runAliceBot();

      // margin-call again
      await expectThrow(margin.marginCall(POSITION_ID, 0, { from: lender2 }));
      await margin.marginCall(POSITION_ID, 0);
      await bucketLender.checkInvariants();

      await doClose(OT.times(3));
      await bucketLender.checkInvariants();

      await wait(60 * 60 * 24 * 1);
      await bucketLender.checkInvariants();

      //  Force-recover collateral
      await margin.forceRecoverCollateral(POSITION_ID, bucketLender.address);
      await bucketLender.checkInvariants();

      // can't deposit after position closed
      const closed = await margin.isPositionClosed(POSITION_ID);
      expect(closed).to.be.true;
      await expectThrow(doDeposit(uselessLender, OT));
      await bucketLender.checkInvariants();

      // do all remaining withdrawals
      for(let a = 0; a < 10; a++) {
        let act = accounts[a];
        for(let b = 0; b < 20; b++) {
          const hasWeight = await bucketLender.weightForBucketForAccount.call(b, act);
          if (!hasWeight.isZero()) {
            await doWithdraw(act, b);
          }
        }
      }

      // check constants
      const [
        c_wasForceClosed,
        c_criticalBucket,
        c_cachedRepaidAmount,
        actualRepaidAmount,

        c_available,
        c_available2,
        c_available3,
        c_principal,
        c_principal2,
        c_weight,
        c_weight2,

        isClosed,

        bucketLenderOwedToken,
        bucketLenderHeldToken,
      ] = await Promise.all([
        bucketLender.wasForceClosed.call(),
        bucketLender.criticalBucket.call(),
        bucketLender.cachedRepaidAmount.call(),
        margin.getTotalOwedTokenRepaidToLender.call(POSITION_ID),

        bucketLender.availableTotal.call(),
        bucketLender.availableForBucket.call(0),
        bucketLender.availableForBucket.call(1),
        bucketLender.principalTotal.call(),
        bucketLender.principalForBucket.call(0),
        bucketLender.weightForBucket.call(0),
        bucketLender.weightForBucketForAccount.call(0, accounts[0]),

        margin.isPositionClosed.call(POSITION_ID),

        owedToken.balanceOf.call(bucketLender.address),
        heldToken.balanceOf.call(bucketLender.address),
      ]);
      expect(c_wasForceClosed).to.be.true;
      expect(c_criticalBucket).to.be.bignumber.eq(5);
      expect(c_cachedRepaidAmount).to.be.bignumber.eq(actualRepaidAmount);
      expect(c_available).to.be.bignumber.eq(0);
      expect(c_available2).to.be.bignumber.eq(0);
      expect(c_available3).to.be.bignumber.eq(0);
      expect(c_principal).to.be.bignumber.eq(0);
      expect(c_principal2).to.be.bignumber.eq(0);
      expect(c_weight).to.be.bignumber.eq(0);
      expect(c_weight2).to.be.bignumber.eq(0);
      expect(isClosed).to.be.true;
      expect(bucketLenderOwedToken).to.be.bignumber.eq(0);
      expect(bucketLenderHeldToken).to.be.bignumber.eq(0);
      await bucketLender.checkInvariants();
    });

    it('Integration test with small numbers', async () => {
      OT = new BigNumber(1);
      await setUpPosition(accounts);
      await runAliceBot();

      await doDeposit(lender1, OT.times(3));
      await runAliceBot();
      await doDeposit(lender1, OT);
      await runAliceBot();

      await doIncrease(OT.times(3));
      await runAliceBot();

      await wait(60 * 60 * 24 * 4);
      await runAliceBot();

      await doDeposit(uselessLender, OT.times(3));
      await runAliceBot();

      await wait(60 * 60 * 24 * 4);
      await runAliceBot();

      await doClose(OT.times(3));
      await runAliceBot();

      await bucketLender.rebalanceBuckets();
      await runAliceBot();

      await doIncrease(OT.times(3));
      await doClose(OT);
      await runAliceBot();
      await doClose(OT);
      await runAliceBot();
      await doClose(OT);
      await runAliceBot();

      await doDeposit(uselessLender, OT.times(3));
      await runAliceBot();

      await wait(60 * 60 * 24 * 1);
      await runAliceBot();

      await doIncrease(OT.times(3));
      await doIncrease(OT.times(5));
      await runAliceBot();

      // expect that the lenders can no longer withdraw their owedToken isnce it has been lent
      await expectThrow(doWithdraw(lender1, 0));
      await expectThrow(doWithdraw(lender2, 0));

      await wait(60 * 60 * 24 * 1);
      await runAliceBot();

      await doClose(OT);
      await runAliceBot();
      await doClose(OT);
      await runAliceBot();
      await doClose(OT);
      await runAliceBot();

      await doClose(OT);
      await runAliceBot();
      await doClose(OT);
      await runAliceBot();
      await doClose(OT);
      await runAliceBot();

      // margin-call
      await expectThrow(margin.marginCall(POSITION_ID, 0, { from: lender1 }));
      await expectThrow(margin.marginCall(POSITION_ID, 1));
      await margin.marginCall(POSITION_ID, 0);
      await bucketLender.checkInvariants();

      // can't deposit while margin-called
      await expectThrow(doDeposit(uselessLender, OT));

      // can't increase position while margin-called
      await doIncrease(OT, {throws: true});
      await bucketLender.checkInvariants();

      await wait(60 * 60 * 24 * 1);
      await bucketLender.checkInvariants();

      // cancel margin-call
      await expectThrow(margin.cancelMarginCall(POSITION_ID, { from: lender1 }));
      await margin.cancelMarginCall(POSITION_ID);
      await runAliceBot();

      // can deposit again
      await doDeposit(uselessLender, OT);
      await runAliceBot();

      // can increase again
      await doIncrease(OT.times(6));
      await runAliceBot();

      await wait(60 * 60 * 24 * 1);
      await runAliceBot();

      // margin-call again
      await expectThrow(margin.marginCall(POSITION_ID, 0, { from: lender2 }));
      await margin.marginCall(POSITION_ID, 0);
      await bucketLender.checkInvariants();

      await doClose(OT.times(3));
      await bucketLender.checkInvariants();

      await wait(60 * 60 * 24 * 1);
      await bucketLender.checkInvariants();

      //  Force-recover collateral
      await margin.forceRecoverCollateral(POSITION_ID, bucketLender.address);
      await bucketLender.checkInvariants();

      // can't deposit after position closed
      const closed = await margin.isPositionClosed(POSITION_ID);
      expect(closed).to.be.true;
      await expectThrow(doDeposit(uselessLender, OT));
      await bucketLender.checkInvariants();

      // do all remaining withdrawals
      for(let a = 0; a < 10; a++) {
        let act = accounts[a];
        for(let b = 0; b < 20; b++) {
          const hasWeight = await bucketLender.weightForBucketForAccount.call(b, act);
          if (!hasWeight.isZero()) {
            await doWithdraw(act, b);
          }
        }
      }

      // check constants
      const [
        c_wasForceClosed,
        c_criticalBucket,
        c_cachedRepaidAmount,
        actualRepaidAmount,

        c_available,
        c_available2,
        c_available3,
        c_principal,
        c_principal2,
        c_weight,
        c_weight2,

        isClosed,

        bucketLenderOwedToken,
        bucketLenderHeldToken,
      ] = await Promise.all([
        bucketLender.wasForceClosed.call(),
        bucketLender.criticalBucket.call(),
        bucketLender.cachedRepaidAmount.call(),
        margin.getTotalOwedTokenRepaidToLender.call(POSITION_ID),

        bucketLender.availableTotal.call(),
        bucketLender.availableForBucket.call(0),
        bucketLender.availableForBucket.call(1),
        bucketLender.principalTotal.call(),
        bucketLender.principalForBucket.call(0),
        bucketLender.weightForBucket.call(0),
        bucketLender.weightForBucketForAccount.call(0, accounts[0]),

        margin.isPositionClosed.call(POSITION_ID),

        owedToken.balanceOf.call(bucketLender.address),
        heldToken.balanceOf.call(bucketLender.address),
      ]);
      expect(c_wasForceClosed).to.be.true;
      expect(c_criticalBucket).to.be.bignumber.eq(0);
      expect(c_cachedRepaidAmount).to.be.bignumber.eq(actualRepaidAmount);
      expect(c_available).to.be.bignumber.eq(0);
      expect(c_available2).to.be.bignumber.eq(0);
      expect(c_available3).to.be.bignumber.eq(0);
      expect(c_principal).to.be.bignumber.eq(0);
      expect(c_principal2).to.be.bignumber.eq(0);
      expect(c_weight).to.be.bignumber.eq(0);
      expect(c_weight2).to.be.bignumber.eq(0);
      expect(isClosed).to.be.true;
      expect(bucketLenderOwedToken).to.be.bignumber.eq(0);
      expect(bucketLenderHeldToken).to.be.bignumber.eq(0);
      await bucketLender.checkInvariants();
    });
  });
});

function createIncreaseTx(trader, principal) {
  return {
    trader: trader,
    id: POSITION_ID,
    principal: principal,
    exchangeWrapper: OpenDirectlyExchangeWrapper.address,
    depositInHeldToken: true,
    buyOrder: { type: ORDER_TYPE.DIRECT },
    loanOffering: {
      owedToken: owedToken.address,
      heldToken: heldToken.address,
      payer: bucketLender.address,
      owner: bucketLender.address,
      taker: ADDRESSES.ZERO,
      positionOwner: ADDRESSES.ZERO,
      feeRecipient: ADDRESSES.ZERO,
      lenderFeeTokenAddress: ADDRESSES.ZERO,
      takerFeeTokenAddress: ADDRESSES.ZERO,
      rates: {
        maxAmount:      BIGNUMBERS.MAX_UINT256,
        minAmount:      BIGNUMBERS.ZERO,
        minHeldToken:   BIGNUMBERS.ZERO,
        lenderFee:      BIGNUMBERS.ZERO,
        takerFee:       BIGNUMBERS.ZERO,
        interestRate:   INTEREST_RATE,
        interestPeriod: INTEREST_PERIOD
      },
      expirationTimestamp: BIGNUMBERS.MAX_UINT256,
      callTimeLimit: BIGNUMBERS.MAX_UINT32,
      maxDuration: BIGNUMBERS.MAX_UINT32,
      salt: 0,
      signature: BYTES.EMPTY
    }
  };
}
