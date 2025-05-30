import * as anchor from "@coral-xyz/anchor";
import { BN } from "@coral-xyz/anchor";
import type { PDA } from "@orca-so/common-sdk";
import { MathUtil, Percentage } from "@orca-so/common-sdk";
import * as assert from "assert";
import Decimal from "decimal.js";
import type {
  DecreaseLiquidityQuote,
  InitPoolV2Params,
  PositionData,
  SwapQuote,
  TwoHopSwapV2Params,
  WhirlpoolData,
} from "../../../../src";
import {
  buildWhirlpoolClient,
  collectRewardsQuote,
  decreaseLiquidityQuoteByLiquidityWithParams,
  NO_ORACLE_DATA,
  NUM_REWARDS,
  PDAUtil,
  swapQuoteWithParams,
  SwapUtils,
  toTx,
  twoHopSwapQuoteFromSwapQuotes,
  WhirlpoolContext,
  WhirlpoolIx,
} from "../../../../src";
import { IGNORE_CACHE } from "../../../../src/network/public/fetcher";
import { getTokenBalance, sleep, TickSpacing, ZERO_BN } from "../../../utils";
import { defaultConfirmOptions } from "../../../utils/const";
import { WhirlpoolTestFixtureV2 } from "../../../utils/v2/fixture-v2";
import type { FundedPositionV2Params } from "../../../utils/v2/init-utils-v2";
import {
  fundPositionsV2,
  initTestPoolWithTokensV2,
} from "../../../utils/v2/init-utils-v2";
import {
  createTokenAccountV2,
  disableRequiredMemoTransfers,
  enableRequiredMemoTransfers,
  isRequiredMemoTransfersEnabled,
} from "../../../utils/v2/token-2022";
import type { PublicKey } from "@solana/web3.js";
import { initTickArrayRange } from "../../../utils/init-utils";
import type { InitAquariumV2Params } from "../../../utils/v2/aquarium-v2";
import {
  buildTestAquariumsV2,
  getDefaultAquariumV2,
  getTokenAccsForPoolsV2,
} from "../../../utils/v2/aquarium-v2";
import { TokenExtensionUtil } from "../../../../src/utils/public/token-extension-util";

describe("TokenExtension/MemoTransfer", () => {
  const provider = anchor.AnchorProvider.local(
    undefined,
    defaultConfirmOptions,
  );
  const program = anchor.workspace.Whirlpool;
  const ctx = WhirlpoolContext.fromWorkspace(provider, program);
  const fetcher = ctx.fetcher;
  const client = buildWhirlpoolClient(ctx);

  const MEMO_TRANSFER_COLLECT_FEES = "Orca CollectFees";
  const MEMO_TRANSFER_COLLECT_PROTOCOL_FEES = "Orca CollectProtocolFees";
  const MEMO_TRANSFER_COLLECT_REWARD = "Orca CollectReward";
  const MEMO_TRANSFER_DECREASE_LIQUIDITY = "Orca Withdraw";
  const MEMO_TRANSFER_SWAP = "Orca Trade";

  describe("collect_fees_v2, collect_protocol_fees_v2", () => {
    let fixture: WhirlpoolTestFixtureV2;
    let feeAccountA: PublicKey;
    let feeAccountB: PublicKey;

    beforeEach(async () => {
      // In same tick array - start index 22528
      const tickLowerIndex = 29440;
      const tickUpperIndex = 33536;

      const tickSpacing = TickSpacing.Standard;
      fixture = await new WhirlpoolTestFixtureV2(ctx).init({
        tokenTraitA: { isToken2022: true },
        tokenTraitB: { isToken2022: true },
        tickSpacing,
        positions: [
          {
            tickLowerIndex,
            tickUpperIndex,
            liquidityAmount: new anchor.BN(10_000_000),
          }, // In range position
          {
            tickLowerIndex: 0,
            tickUpperIndex: 128,
            liquidityAmount: new anchor.BN(1_000_000),
          }, // Out of range position
        ],
      });
      const {
        poolInitInfo: {
          whirlpoolPda,
          tokenVaultAKeypair,
          tokenVaultBKeypair,
          tokenMintA,
          tokenMintB,
          tokenProgramA,
          tokenProgramB,
        },
        tokenAccountA,
        tokenAccountB,
        positions,
      } = fixture.getInfos();

      const tickArrayPda = PDAUtil.getTickArray(
        ctx.program.programId,
        whirlpoolPda.publicKey,
        22528,
      );
      const oraclePda = PDAUtil.getOracle(
        ctx.program.programId,
        whirlpoolPda.publicKey,
      );

      // Accrue fees in token A
      await toTx(
        ctx,
        WhirlpoolIx.swapV2Ix(ctx.program, {
          amount: new BN(200_000),
          otherAmountThreshold: ZERO_BN,
          sqrtPriceLimit: MathUtil.toX64(new Decimal(4)),
          amountSpecifiedIsInput: true,
          aToB: true,
          whirlpool: whirlpoolPda.publicKey,
          tokenAuthority: ctx.wallet.publicKey,
          tokenMintA,
          tokenMintB,
          tokenProgramA,
          tokenProgramB,
          tokenOwnerAccountA: tokenAccountA,
          tokenVaultA: tokenVaultAKeypair.publicKey,
          tokenOwnerAccountB: tokenAccountB,
          tokenVaultB: tokenVaultBKeypair.publicKey,
          tickArray0: tickArrayPda.publicKey,
          tickArray1: tickArrayPda.publicKey,
          tickArray2: tickArrayPda.publicKey,
          oracle: oraclePda.publicKey,
        }),
      ).buildAndExecute();

      // Accrue fees in token B
      await toTx(
        ctx,
        WhirlpoolIx.swapV2Ix(ctx.program, {
          amount: new BN(200_000),
          otherAmountThreshold: ZERO_BN,
          sqrtPriceLimit: MathUtil.toX64(new Decimal(5)),
          amountSpecifiedIsInput: true,
          aToB: false,
          whirlpool: whirlpoolPda.publicKey,
          tokenAuthority: ctx.wallet.publicKey,
          tokenMintA,
          tokenMintB,
          tokenProgramA,
          tokenProgramB,
          tokenOwnerAccountA: tokenAccountA,
          tokenVaultA: tokenVaultAKeypair.publicKey,
          tokenOwnerAccountB: tokenAccountB,
          tokenVaultB: tokenVaultBKeypair.publicKey,
          tickArray0: tickArrayPda.publicKey,
          tickArray1: tickArrayPda.publicKey,
          tickArray2: tickArrayPda.publicKey,
          oracle: oraclePda.publicKey,
        }),
      ).buildAndExecute();

      await toTx(
        ctx,
        WhirlpoolIx.updateFeesAndRewardsIx(ctx.program, {
          whirlpool: whirlpoolPda.publicKey,
          position: positions[0].publicKey,
          tickArrayLower: tickArrayPda.publicKey,
          tickArrayUpper: tickArrayPda.publicKey,
        }),
      ).buildAndExecute();

      const whirlpoolData = (await fetcher.getPool(
        whirlpoolPda.publicKey,
        IGNORE_CACHE,
      ))!;
      assert.ok(!whirlpoolData.protocolFeeOwedA.isZero());
      assert.ok(!whirlpoolData.protocolFeeOwedB.isZero());

      const positionBeforeCollect = (await fetcher.getPosition(
        positions[0].publicKey,
        IGNORE_CACHE,
      )) as PositionData;
      assert.ok(!positionBeforeCollect.feeOwedA.isZero());
      assert.ok(!positionBeforeCollect.feeOwedB.isZero());

      feeAccountA = await createTokenAccountV2(
        provider,
        { isToken2022: true },
        tokenMintA,
        provider.wallet.publicKey,
      );
      feeAccountB = await createTokenAccountV2(
        provider,
        { isToken2022: true },
        tokenMintB,
        provider.wallet.publicKey,
      );
    });

    it("collect_fees_v2: without memo", async () => {
      const {
        poolInitInfo: {
          whirlpoolPda,
          tokenVaultAKeypair,
          tokenVaultBKeypair,
          tokenMintA,
          tokenMintB,
          tokenProgramA,
          tokenProgramB,
        },
        positions,
      } = fixture.getInfos();

      assert.ok(!(await isRequiredMemoTransfersEnabled(provider, feeAccountA)));
      assert.ok(!(await isRequiredMemoTransfersEnabled(provider, feeAccountB)));

      const sig = await toTx(
        ctx,
        WhirlpoolIx.collectFeesV2Ix(ctx.program, {
          whirlpool: whirlpoolPda.publicKey,
          positionAuthority: provider.wallet.publicKey,
          position: positions[0].publicKey,
          positionTokenAccount: positions[0].tokenAccount,
          tokenMintA,
          tokenMintB,
          tokenProgramA,
          tokenProgramB,
          tokenOwnerAccountA: feeAccountA,
          tokenOwnerAccountB: feeAccountB,
          tokenVaultA: tokenVaultAKeypair.publicKey,
          tokenVaultB: tokenVaultBKeypair.publicKey,
        }),
      ).buildAndExecute();
      const feeBalanceA = await getTokenBalance(provider, feeAccountA);
      const feeBalanceB = await getTokenBalance(provider, feeAccountB);
      assert.ok(new BN(feeBalanceA).gtn(0));
      assert.ok(new BN(feeBalanceB).gtn(0));

      const memoCount = await countMemoLog(
        provider,
        sig,
        MEMO_TRANSFER_COLLECT_FEES,
      );
      assert.equal(memoCount, 0);
    });

    it("collect_fees_v2: with memo", async () => {
      const {
        poolInitInfo: {
          whirlpoolPda,
          tokenVaultAKeypair,
          tokenVaultBKeypair,
          tokenMintA,
          tokenMintB,
          tokenProgramA,
          tokenProgramB,
        },
        positions,
      } = fixture.getInfos();

      await enableRequiredMemoTransfers(provider, feeAccountA);
      await enableRequiredMemoTransfers(provider, feeAccountB);

      assert.ok(await isRequiredMemoTransfersEnabled(provider, feeAccountA));
      assert.ok(await isRequiredMemoTransfersEnabled(provider, feeAccountB));

      const sig = await toTx(
        ctx,
        WhirlpoolIx.collectFeesV2Ix(ctx.program, {
          whirlpool: whirlpoolPda.publicKey,
          positionAuthority: provider.wallet.publicKey,
          position: positions[0].publicKey,
          positionTokenAccount: positions[0].tokenAccount,
          tokenMintA,
          tokenMintB,
          tokenProgramA,
          tokenProgramB,
          tokenOwnerAccountA: feeAccountA,
          tokenOwnerAccountB: feeAccountB,
          tokenVaultA: tokenVaultAKeypair.publicKey,
          tokenVaultB: tokenVaultBKeypair.publicKey,
        }),
      ).buildAndExecute();
      const feeBalanceA = await getTokenBalance(provider, feeAccountA);
      const feeBalanceB = await getTokenBalance(provider, feeAccountB);
      assert.ok(new BN(feeBalanceA).gtn(0));
      assert.ok(new BN(feeBalanceB).gtn(0));

      const memoCount = await countMemoLog(
        provider,
        sig,
        MEMO_TRANSFER_COLLECT_FEES,
      );
      assert.equal(memoCount, 2);
    });

    it("collect_fees_v2: without memo (has extension, but disabled)", async () => {
      const {
        poolInitInfo: {
          whirlpoolPda,
          tokenVaultAKeypair,
          tokenVaultBKeypair,
          tokenMintA,
          tokenMintB,
          tokenProgramA,
          tokenProgramB,
        },
        positions,
      } = fixture.getInfos();

      await enableRequiredMemoTransfers(provider, feeAccountA);
      await enableRequiredMemoTransfers(provider, feeAccountB);
      assert.ok(await isRequiredMemoTransfersEnabled(provider, feeAccountA));
      assert.ok(await isRequiredMemoTransfersEnabled(provider, feeAccountB));

      await disableRequiredMemoTransfers(provider, feeAccountA);
      await disableRequiredMemoTransfers(provider, feeAccountB);
      assert.ok(!(await isRequiredMemoTransfersEnabled(provider, feeAccountA)));
      assert.ok(!(await isRequiredMemoTransfersEnabled(provider, feeAccountB)));

      const sig = await toTx(
        ctx,
        WhirlpoolIx.collectFeesV2Ix(ctx.program, {
          whirlpool: whirlpoolPda.publicKey,
          positionAuthority: provider.wallet.publicKey,
          position: positions[0].publicKey,
          positionTokenAccount: positions[0].tokenAccount,
          tokenMintA,
          tokenMintB,
          tokenProgramA,
          tokenProgramB,
          tokenOwnerAccountA: feeAccountA,
          tokenOwnerAccountB: feeAccountB,
          tokenVaultA: tokenVaultAKeypair.publicKey,
          tokenVaultB: tokenVaultBKeypair.publicKey,
        }),
      ).buildAndExecute();
      const feeBalanceA = await getTokenBalance(provider, feeAccountA);
      const feeBalanceB = await getTokenBalance(provider, feeAccountB);
      assert.ok(new BN(feeBalanceA).gtn(0));
      assert.ok(new BN(feeBalanceB).gtn(0));

      const memoCount = await countMemoLog(
        provider,
        sig,
        MEMO_TRANSFER_COLLECT_FEES,
      );
      assert.equal(memoCount, 0);
    });

    it("collect_protocol_fees_v2: without memo", async () => {
      const {
        poolInitInfo: {
          whirlpoolPda,
          tokenVaultAKeypair,
          tokenVaultBKeypair,
          tokenMintA,
          tokenMintB,
          tokenProgramA,
          tokenProgramB,
        },
        configKeypairs: { collectProtocolFeesAuthorityKeypair },
        configInitInfo: { whirlpoolsConfigKeypair: whirlpoolsConfigKeypair },
      } = fixture.getInfos();

      assert.ok(!(await isRequiredMemoTransfersEnabled(provider, feeAccountA)));
      assert.ok(!(await isRequiredMemoTransfersEnabled(provider, feeAccountB)));

      const sig = await toTx(
        ctx,
        WhirlpoolIx.collectProtocolFeesV2Ix(ctx.program, {
          whirlpoolsConfig: whirlpoolsConfigKeypair.publicKey,
          whirlpool: whirlpoolPda.publicKey,
          collectProtocolFeesAuthority:
            collectProtocolFeesAuthorityKeypair.publicKey,
          tokenMintA,
          tokenMintB,
          tokenProgramA,
          tokenProgramB,
          tokenVaultA: tokenVaultAKeypair.publicKey,
          tokenVaultB: tokenVaultBKeypair.publicKey,
          tokenOwnerAccountA: feeAccountA,
          tokenOwnerAccountB: feeAccountB,
        }),
      )
        .addSigner(collectProtocolFeesAuthorityKeypair)
        .buildAndExecute();
      const feeBalanceA = await getTokenBalance(provider, feeAccountA);
      const feeBalanceB = await getTokenBalance(provider, feeAccountB);
      assert.ok(new BN(feeBalanceA).gtn(0));
      assert.ok(new BN(feeBalanceB).gtn(0));

      const memoCount = await countMemoLog(
        provider,
        sig,
        MEMO_TRANSFER_COLLECT_PROTOCOL_FEES,
      );
      assert.equal(memoCount, 0);
    });

    it("collect_protocol_fees_v2: with memo", async () => {
      const {
        poolInitInfo: {
          whirlpoolPda,
          tokenVaultAKeypair,
          tokenVaultBKeypair,
          tokenMintA,
          tokenMintB,
          tokenProgramA,
          tokenProgramB,
        },
        configKeypairs: { collectProtocolFeesAuthorityKeypair },
        configInitInfo: { whirlpoolsConfigKeypair: whirlpoolsConfigKeypair },
      } = fixture.getInfos();

      await enableRequiredMemoTransfers(provider, feeAccountA);
      await enableRequiredMemoTransfers(provider, feeAccountB);

      assert.ok(await isRequiredMemoTransfersEnabled(provider, feeAccountA));
      assert.ok(await isRequiredMemoTransfersEnabled(provider, feeAccountB));

      const sig = await toTx(
        ctx,
        WhirlpoolIx.collectProtocolFeesV2Ix(ctx.program, {
          whirlpoolsConfig: whirlpoolsConfigKeypair.publicKey,
          whirlpool: whirlpoolPda.publicKey,
          collectProtocolFeesAuthority:
            collectProtocolFeesAuthorityKeypair.publicKey,
          tokenMintA,
          tokenMintB,
          tokenProgramA,
          tokenProgramB,
          tokenVaultA: tokenVaultAKeypair.publicKey,
          tokenVaultB: tokenVaultBKeypair.publicKey,
          tokenOwnerAccountA: feeAccountA,
          tokenOwnerAccountB: feeAccountB,
        }),
      )
        .addSigner(collectProtocolFeesAuthorityKeypair)
        .buildAndExecute();
      const feeBalanceA = await getTokenBalance(provider, feeAccountA);
      const feeBalanceB = await getTokenBalance(provider, feeAccountB);
      assert.ok(new BN(feeBalanceA).gtn(0));
      assert.ok(new BN(feeBalanceB).gtn(0));

      const memoCount = await countMemoLog(
        provider,
        sig,
        MEMO_TRANSFER_COLLECT_PROTOCOL_FEES,
      );
      assert.equal(memoCount, 2);
    });

    it("collect_protocol_fees_v2: without memo (has extension, but disabled)", async () => {
      const {
        poolInitInfo: {
          whirlpoolPda,
          tokenVaultAKeypair,
          tokenVaultBKeypair,
          tokenMintA,
          tokenMintB,
          tokenProgramA,
          tokenProgramB,
        },
        configKeypairs: { collectProtocolFeesAuthorityKeypair },
        configInitInfo: { whirlpoolsConfigKeypair: whirlpoolsConfigKeypair },
      } = fixture.getInfos();

      await enableRequiredMemoTransfers(provider, feeAccountA);
      await enableRequiredMemoTransfers(provider, feeAccountB);
      assert.ok(await isRequiredMemoTransfersEnabled(provider, feeAccountA));
      assert.ok(await isRequiredMemoTransfersEnabled(provider, feeAccountB));

      await disableRequiredMemoTransfers(provider, feeAccountA);
      await disableRequiredMemoTransfers(provider, feeAccountB);
      assert.ok(!(await isRequiredMemoTransfersEnabled(provider, feeAccountA)));
      assert.ok(!(await isRequiredMemoTransfersEnabled(provider, feeAccountB)));

      const sig = await toTx(
        ctx,
        WhirlpoolIx.collectProtocolFeesV2Ix(ctx.program, {
          whirlpoolsConfig: whirlpoolsConfigKeypair.publicKey,
          whirlpool: whirlpoolPda.publicKey,
          collectProtocolFeesAuthority:
            collectProtocolFeesAuthorityKeypair.publicKey,
          tokenMintA,
          tokenMintB,
          tokenProgramA,
          tokenProgramB,
          tokenVaultA: tokenVaultAKeypair.publicKey,
          tokenVaultB: tokenVaultBKeypair.publicKey,
          tokenOwnerAccountA: feeAccountA,
          tokenOwnerAccountB: feeAccountB,
        }),
      )
        .addSigner(collectProtocolFeesAuthorityKeypair)
        .buildAndExecute();
      const feeBalanceA = await getTokenBalance(provider, feeAccountA);
      const feeBalanceB = await getTokenBalance(provider, feeAccountB);
      assert.ok(new BN(feeBalanceA).gtn(0));
      assert.ok(new BN(feeBalanceB).gtn(0));

      const memoCount = await countMemoLog(
        provider,
        sig,
        MEMO_TRANSFER_COLLECT_PROTOCOL_FEES,
      );
      assert.equal(memoCount, 0);
    });
  });

  describe("collect_reward_v2", () => {
    let fixture: WhirlpoolTestFixtureV2;
    let rewardAccounts: PublicKey[];

    beforeEach(async () => {
      const vaultStartBalance = 1_000_000;
      const lowerTickIndex = -1280,
        upperTickIndex = 1280,
        tickSpacing = TickSpacing.Standard;
      fixture = await new WhirlpoolTestFixtureV2(ctx).init({
        tokenTraitA: { isToken2022: true },
        tokenTraitB: { isToken2022: true },
        tickSpacing: tickSpacing,
        initialSqrtPrice: MathUtil.toX64(new Decimal(1)),
        positions: [
          {
            tickLowerIndex: lowerTickIndex,
            tickUpperIndex: upperTickIndex,
            liquidityAmount: new anchor.BN(1_000_000),
          },
        ],
        rewards: [
          {
            rewardTokenTrait: { isToken2022: true },
            emissionsPerSecondX64: MathUtil.toX64(new Decimal(10)),
            vaultAmount: new BN(vaultStartBalance),
          },
          {
            rewardTokenTrait: { isToken2022: true },
            emissionsPerSecondX64: MathUtil.toX64(new Decimal(10)),
            vaultAmount: new BN(vaultStartBalance),
          },
          {
            rewardTokenTrait: { isToken2022: true },
            emissionsPerSecondX64: MathUtil.toX64(new Decimal(10)),
            vaultAmount: new BN(vaultStartBalance),
          },
        ],
      });
      const {
        poolInitInfo: { whirlpoolPda },
        positions,
        rewards,
      } = fixture.getInfos();

      // accrue rewards
      await sleep(3000);

      await toTx(
        ctx,
        WhirlpoolIx.updateFeesAndRewardsIx(ctx.program, {
          whirlpool: whirlpoolPda.publicKey,
          position: positions[0].publicKey,
          tickArrayLower: positions[0].tickArrayLower,
          tickArrayUpper: positions[0].tickArrayUpper,
        }),
      ).buildAndExecute();

      // Generate collect reward expectation
      const whirlpoolData = (await fetcher.getPool(
        whirlpoolPda.publicKey,
      )) as WhirlpoolData;
      const positionPreCollect = await client.getPosition(
        positions[0].publicKey,
        IGNORE_CACHE,
      );

      // Lock the collectRewards quote to the last time we called updateFeesAndRewards
      const expectation = collectRewardsQuote({
        whirlpool: whirlpoolData,
        position: positionPreCollect.getData(),
        tickLower: positionPreCollect.getLowerTickData(),
        tickUpper: positionPreCollect.getUpperTickData(),
        timeStampInSeconds: whirlpoolData.rewardLastUpdatedTimestamp,
        tokenExtensionCtx: await TokenExtensionUtil.buildTokenExtensionContext(
          fetcher,
          whirlpoolData,
          IGNORE_CACHE,
        ),
      });

      // Check that the expectation is not zero
      for (let i = 0; i < NUM_REWARDS; i++) {
        assert.ok(!expectation.rewardOwed[i]!.isZero());
      }

      rewardAccounts = await Promise.all(
        rewards.map((reward) => {
          return createTokenAccountV2(
            provider,
            { isToken2022: true },
            reward.rewardMint,
            provider.wallet.publicKey,
          );
        }),
      );
    });

    it("collect_reward_v2: without memo", async () => {
      const {
        poolInitInfo: { whirlpoolPda },
        positions,
        rewards,
      } = fixture.getInfos();

      for (let i = 0; i < NUM_REWARDS; i++) {
        assert.ok(
          !(await isRequiredMemoTransfersEnabled(provider, rewardAccounts[i])),
        );

        const sig = await toTx(
          ctx,
          WhirlpoolIx.collectRewardV2Ix(ctx.program, {
            whirlpool: whirlpoolPda.publicKey,
            positionAuthority: provider.wallet.publicKey,
            position: positions[0].publicKey,
            positionTokenAccount: positions[0].tokenAccount,
            rewardMint: rewards[i].rewardMint,
            rewardTokenProgram: rewards[i].tokenProgram,
            rewardOwnerAccount: rewardAccounts[i],
            rewardVault: rewards[i].rewardVaultKeypair.publicKey,
            rewardIndex: i,
          }),
        ).buildAndExecute();
        const rewardBalance = await getTokenBalance(
          provider,
          rewardAccounts[i],
        );
        assert.ok(new BN(rewardBalance).gtn(0));

        const memoCount = await countMemoLog(
          provider,
          sig,
          MEMO_TRANSFER_COLLECT_REWARD,
        );
        assert.equal(memoCount, 0);
      }
    });

    it("collect_reward_v2: with memo", async () => {
      const {
        poolInitInfo: { whirlpoolPda },
        positions,
        rewards,
      } = fixture.getInfos();

      for (let i = 0; i < NUM_REWARDS; i++) {
        await enableRequiredMemoTransfers(provider, rewardAccounts[i]);
        assert.ok(
          await isRequiredMemoTransfersEnabled(provider, rewardAccounts[i]),
        );

        const sig = await toTx(
          ctx,
          WhirlpoolIx.collectRewardV2Ix(ctx.program, {
            whirlpool: whirlpoolPda.publicKey,
            positionAuthority: provider.wallet.publicKey,
            position: positions[0].publicKey,
            positionTokenAccount: positions[0].tokenAccount,
            rewardMint: rewards[i].rewardMint,
            rewardTokenProgram: rewards[i].tokenProgram,
            rewardOwnerAccount: rewardAccounts[i],
            rewardVault: rewards[i].rewardVaultKeypair.publicKey,
            rewardIndex: i,
          }),
        ).buildAndExecute();
        const rewardBalance = await getTokenBalance(
          provider,
          rewardAccounts[i],
        );
        assert.ok(new BN(rewardBalance).gtn(0));

        const memoCount = await countMemoLog(
          provider,
          sig,
          MEMO_TRANSFER_COLLECT_REWARD,
        );
        assert.equal(memoCount, 1);
      }
    });

    it("collect_reward_v2: without memo (has extension, but disabled)", async () => {
      const {
        poolInitInfo: { whirlpoolPda },
        positions,
        rewards,
      } = fixture.getInfos();

      for (let i = 0; i < NUM_REWARDS; i++) {
        await enableRequiredMemoTransfers(provider, rewardAccounts[i]);
        assert.ok(
          await isRequiredMemoTransfersEnabled(provider, rewardAccounts[i]),
        );
        await disableRequiredMemoTransfers(provider, rewardAccounts[i]);
        assert.ok(
          !(await isRequiredMemoTransfersEnabled(provider, rewardAccounts[i])),
        );

        const sig = await toTx(
          ctx,
          WhirlpoolIx.collectRewardV2Ix(ctx.program, {
            whirlpool: whirlpoolPda.publicKey,
            positionAuthority: provider.wallet.publicKey,
            position: positions[0].publicKey,
            positionTokenAccount: positions[0].tokenAccount,
            rewardMint: rewards[i].rewardMint,
            rewardTokenProgram: rewards[i].tokenProgram,
            rewardOwnerAccount: rewardAccounts[i],
            rewardVault: rewards[i].rewardVaultKeypair.publicKey,
            rewardIndex: i,
          }),
        ).buildAndExecute();
        const rewardBalance = await getTokenBalance(
          provider,
          rewardAccounts[i],
        );
        assert.ok(new BN(rewardBalance).gtn(0));

        const memoCount = await countMemoLog(
          provider,
          sig,
          MEMO_TRANSFER_COLLECT_REWARD,
        );
        assert.equal(memoCount, 0);
      }
    });
  });

  describe("decrease_liquidity_v2", () => {
    let fixture: WhirlpoolTestFixtureV2;
    let removalQuote: DecreaseLiquidityQuote;
    let destAccountA: PublicKey;
    let destAccountB: PublicKey;

    beforeEach(async () => {
      const liquidityAmount = new anchor.BN(1_250_000);
      const tickLower = 7168,
        tickUpper = 8960;
      fixture = await new WhirlpoolTestFixtureV2(ctx).init({
        tokenTraitA: { isToken2022: true },
        tokenTraitB: { isToken2022: true },
        tickSpacing: TickSpacing.Standard,
        initialSqrtPrice: MathUtil.toX64(new Decimal(1.48)),
        positions: [
          {
            tickLowerIndex: tickLower,
            tickUpperIndex: tickUpper,
            liquidityAmount,
          },
        ],
      });
      const { poolInitInfo } = fixture.getInfos();
      const { whirlpoolPda } = poolInitInfo;
      const poolBefore = (await fetcher.getPool(
        whirlpoolPda.publicKey,
        IGNORE_CACHE,
      )) as WhirlpoolData;

      removalQuote = decreaseLiquidityQuoteByLiquidityWithParams({
        liquidity: new anchor.BN(1_000_000),
        sqrtPrice: poolBefore.sqrtPrice,
        slippageTolerance: Percentage.fromFraction(1, 100),
        tickCurrentIndex: poolBefore.tickCurrentIndex,
        tickLowerIndex: tickLower,
        tickUpperIndex: tickUpper,
        tokenExtensionCtx: await TokenExtensionUtil.buildTokenExtensionContext(
          fetcher,
          poolBefore,
          IGNORE_CACHE,
        ),
      });
      assert.ok(!removalQuote.tokenEstA.isZero());
      assert.ok(!removalQuote.tokenEstB.isZero());

      destAccountA = await createTokenAccountV2(
        provider,
        { isToken2022: true },
        poolInitInfo.tokenMintA,
        provider.wallet.publicKey,
      );
      destAccountB = await createTokenAccountV2(
        provider,
        { isToken2022: true },
        poolInitInfo.tokenMintB,
        provider.wallet.publicKey,
      );
    });

    it("decrease_liquidity_v2: without memo", async () => {
      const { poolInitInfo, positions } = fixture.getInfos();

      const sig = await toTx(
        ctx,
        WhirlpoolIx.decreaseLiquidityV2Ix(ctx.program, {
          ...removalQuote,
          whirlpool: poolInitInfo.whirlpoolPda.publicKey,
          positionAuthority: provider.wallet.publicKey,
          position: positions[0].publicKey,
          positionTokenAccount: positions[0].tokenAccount,
          tokenMintA: poolInitInfo.tokenMintA,
          tokenMintB: poolInitInfo.tokenMintB,
          tokenProgramA: poolInitInfo.tokenProgramA,
          tokenProgramB: poolInitInfo.tokenProgramB,
          tokenOwnerAccountA: destAccountA,
          tokenOwnerAccountB: destAccountB,
          tokenVaultA: poolInitInfo.tokenVaultAKeypair.publicKey,
          tokenVaultB: poolInitInfo.tokenVaultBKeypair.publicKey,
          tickArrayLower: positions[0].tickArrayLower,
          tickArrayUpper: positions[0].tickArrayUpper,
        }),
      ).buildAndExecute();
      const destBalanceA = await getTokenBalance(provider, destAccountA);
      const destBalanceB = await getTokenBalance(provider, destAccountB);
      assert.ok(new BN(destBalanceA).gtn(0));
      assert.ok(new BN(destBalanceB).gtn(0));

      const memoCount = await countMemoLog(
        provider,
        sig,
        MEMO_TRANSFER_DECREASE_LIQUIDITY,
      );
      assert.equal(memoCount, 0);
    });

    it("decrease_liquidity_v2: with memo", async () => {
      const { poolInitInfo, positions } = fixture.getInfos();

      await enableRequiredMemoTransfers(provider, destAccountA);
      await enableRequiredMemoTransfers(provider, destAccountB);
      assert.ok(await isRequiredMemoTransfersEnabled(provider, destAccountA));
      assert.ok(await isRequiredMemoTransfersEnabled(provider, destAccountB));

      const sig = await toTx(
        ctx,
        WhirlpoolIx.decreaseLiquidityV2Ix(ctx.program, {
          ...removalQuote,
          whirlpool: poolInitInfo.whirlpoolPda.publicKey,
          positionAuthority: provider.wallet.publicKey,
          position: positions[0].publicKey,
          positionTokenAccount: positions[0].tokenAccount,
          tokenMintA: poolInitInfo.tokenMintA,
          tokenMintB: poolInitInfo.tokenMintB,
          tokenProgramA: poolInitInfo.tokenProgramA,
          tokenProgramB: poolInitInfo.tokenProgramB,
          tokenOwnerAccountA: destAccountA,
          tokenOwnerAccountB: destAccountB,
          tokenVaultA: poolInitInfo.tokenVaultAKeypair.publicKey,
          tokenVaultB: poolInitInfo.tokenVaultBKeypair.publicKey,
          tickArrayLower: positions[0].tickArrayLower,
          tickArrayUpper: positions[0].tickArrayUpper,
        }),
      ).buildAndExecute();
      const destBalanceA = await getTokenBalance(provider, destAccountA);
      const destBalanceB = await getTokenBalance(provider, destAccountB);
      assert.ok(new BN(destBalanceA).gtn(0));
      assert.ok(new BN(destBalanceB).gtn(0));

      const memoCount = await countMemoLog(
        provider,
        sig,
        MEMO_TRANSFER_DECREASE_LIQUIDITY,
      );
      assert.equal(memoCount, 2);
    });

    it("decrease_liquidity_v2: without memo (has extension, but disabled)", async () => {
      const { poolInitInfo, positions } = fixture.getInfos();

      await enableRequiredMemoTransfers(provider, destAccountA);
      await enableRequiredMemoTransfers(provider, destAccountB);
      assert.ok(await isRequiredMemoTransfersEnabled(provider, destAccountA));
      assert.ok(await isRequiredMemoTransfersEnabled(provider, destAccountB));

      await disableRequiredMemoTransfers(provider, destAccountA);
      await disableRequiredMemoTransfers(provider, destAccountB);
      assert.ok(
        !(await isRequiredMemoTransfersEnabled(provider, destAccountA)),
      );
      assert.ok(
        !(await isRequiredMemoTransfersEnabled(provider, destAccountB)),
      );

      const sig = await toTx(
        ctx,
        WhirlpoolIx.decreaseLiquidityV2Ix(ctx.program, {
          ...removalQuote,
          whirlpool: poolInitInfo.whirlpoolPda.publicKey,
          positionAuthority: provider.wallet.publicKey,
          position: positions[0].publicKey,
          positionTokenAccount: positions[0].tokenAccount,
          tokenMintA: poolInitInfo.tokenMintA,
          tokenMintB: poolInitInfo.tokenMintB,
          tokenProgramA: poolInitInfo.tokenProgramA,
          tokenProgramB: poolInitInfo.tokenProgramB,
          tokenOwnerAccountA: destAccountA,
          tokenOwnerAccountB: destAccountB,
          tokenVaultA: poolInitInfo.tokenVaultAKeypair.publicKey,
          tokenVaultB: poolInitInfo.tokenVaultBKeypair.publicKey,
          tickArrayLower: positions[0].tickArrayLower,
          tickArrayUpper: positions[0].tickArrayUpper,
        }),
      ).buildAndExecute();
      const destBalanceA = await getTokenBalance(provider, destAccountA);
      const destBalanceB = await getTokenBalance(provider, destAccountB);
      assert.ok(new BN(destBalanceA).gtn(0));
      assert.ok(new BN(destBalanceB).gtn(0));

      const memoCount = await countMemoLog(
        provider,
        sig,
        MEMO_TRANSFER_DECREASE_LIQUIDITY,
      );
      assert.equal(memoCount, 0);
    });
  });

  describe("swap_v2", () => {
    let poolInitInfo: InitPoolV2Params;
    let whirlpoolPda: PDA;
    let tokenAccountA: PublicKey;
    let tokenAccountB: PublicKey;
    let oraclePubkey: PublicKey;
    let quoteAToB: SwapQuote;
    let quoteBToA: SwapQuote;

    beforeEach(async () => {
      const init = await initTestPoolWithTokensV2(
        ctx,
        { isToken2022: true },
        { isToken2022: true },
        TickSpacing.Standard,
      );
      poolInitInfo = init.poolInitInfo;
      whirlpoolPda = init.whirlpoolPda;
      tokenAccountA = init.tokenAccountA;
      tokenAccountB = init.tokenAccountB;

      const aToB = false;
      await initTickArrayRange(
        ctx,
        whirlpoolPda.publicKey,
        22528, // to 33792
        3,
        TickSpacing.Standard,
        aToB,
      );

      const fundParams: FundedPositionV2Params[] = [
        {
          liquidityAmount: new anchor.BN(10_000_000),
          tickLowerIndex: 29440,
          tickUpperIndex: 33536,
        },
      ];

      await fundPositionsV2(
        ctx,
        poolInitInfo,
        tokenAccountA,
        tokenAccountB,
        fundParams,
      );

      oraclePubkey = PDAUtil.getOracle(
        ctx.program.programId,
        whirlpoolPda.publicKey,
      ).publicKey;

      const whirlpoolKey = poolInitInfo.whirlpoolPda.publicKey;
      const whirlpoolData = (await fetcher.getPool(
        whirlpoolKey,
        IGNORE_CACHE,
      )) as WhirlpoolData;

      quoteAToB = swapQuoteWithParams(
        {
          amountSpecifiedIsInput: true,
          aToB: true,
          tokenAmount: new BN(100000),
          otherAmountThreshold: SwapUtils.getDefaultOtherAmountThreshold(true),
          sqrtPriceLimit: SwapUtils.getDefaultSqrtPriceLimit(true),
          whirlpoolData,
          tickArrays: await SwapUtils.getTickArrays(
            whirlpoolData.tickCurrentIndex,
            whirlpoolData.tickSpacing,
            true,
            ctx.program.programId,
            whirlpoolKey,
            fetcher,
            IGNORE_CACHE,
          ),
          tokenExtensionCtx:
            await TokenExtensionUtil.buildTokenExtensionContext(
              fetcher,
              whirlpoolData,
              IGNORE_CACHE,
            ),
          oracleData: NO_ORACLE_DATA,
        },
        Percentage.fromFraction(100, 100), // 100% slippage
      );

      quoteBToA = swapQuoteWithParams(
        {
          amountSpecifiedIsInput: true,
          aToB: false,
          tokenAmount: new BN(100000),
          otherAmountThreshold: SwapUtils.getDefaultOtherAmountThreshold(true),
          sqrtPriceLimit: SwapUtils.getDefaultSqrtPriceLimit(false),
          whirlpoolData,
          tickArrays: await SwapUtils.getTickArrays(
            whirlpoolData.tickCurrentIndex,
            whirlpoolData.tickSpacing,
            false,
            ctx.program.programId,
            whirlpoolKey,
            fetcher,
            IGNORE_CACHE,
          ),
          tokenExtensionCtx:
            await TokenExtensionUtil.buildTokenExtensionContext(
              fetcher,
              whirlpoolData,
              IGNORE_CACHE,
            ),
          oracleData: NO_ORACLE_DATA,
        },
        Percentage.fromFraction(100, 100), // 100% slippage
      );
    });

    it("swap_v2: without memo", async () => {
      const balanceA0 = new BN(await getTokenBalance(provider, tokenAccountA));
      const balanceB0 = new BN(await getTokenBalance(provider, tokenAccountB));

      const sigBToA = await toTx(
        ctx,
        WhirlpoolIx.swapV2Ix(ctx.program, {
          ...quoteBToA,
          whirlpool: whirlpoolPda.publicKey,
          tokenAuthority: ctx.wallet.publicKey,
          tokenMintA: poolInitInfo.tokenMintA,
          tokenMintB: poolInitInfo.tokenMintB,
          tokenProgramA: poolInitInfo.tokenProgramA,
          tokenProgramB: poolInitInfo.tokenProgramB,
          tokenOwnerAccountA: tokenAccountA,
          tokenVaultA: poolInitInfo.tokenVaultAKeypair.publicKey,
          tokenOwnerAccountB: tokenAccountB,
          tokenVaultB: poolInitInfo.tokenVaultBKeypair.publicKey,
          oracle: oraclePubkey,
        }),
      ).buildAndExecute();

      const balanceA1 = new BN(await getTokenBalance(provider, tokenAccountA));
      const balanceB1 = new BN(await getTokenBalance(provider, tokenAccountB));
      assert.ok(balanceB1.lt(balanceB0));
      assert.ok(balanceA1.gt(balanceA0));

      const memoCountBToA = await countMemoLog(
        provider,
        sigBToA,
        MEMO_TRANSFER_SWAP,
      );
      assert.equal(memoCountBToA, 0);

      const sigAToB = await toTx(
        ctx,
        WhirlpoolIx.swapV2Ix(ctx.program, {
          ...quoteAToB,
          whirlpool: whirlpoolPda.publicKey,
          tokenAuthority: ctx.wallet.publicKey,
          tokenMintA: poolInitInfo.tokenMintA,
          tokenMintB: poolInitInfo.tokenMintB,
          tokenProgramA: poolInitInfo.tokenProgramA,
          tokenProgramB: poolInitInfo.tokenProgramB,
          tokenOwnerAccountA: tokenAccountA,
          tokenVaultA: poolInitInfo.tokenVaultAKeypair.publicKey,
          tokenOwnerAccountB: tokenAccountB,
          tokenVaultB: poolInitInfo.tokenVaultBKeypair.publicKey,
          oracle: oraclePubkey,
        }),
      ).buildAndExecute();

      const balanceA2 = new BN(await getTokenBalance(provider, tokenAccountA));
      const balanceB2 = new BN(await getTokenBalance(provider, tokenAccountB));
      assert.ok(balanceA2.lt(balanceA1));
      assert.ok(balanceB2.gt(balanceB1));

      const memoCountAToB = await countMemoLog(
        provider,
        sigAToB,
        MEMO_TRANSFER_SWAP,
      );
      assert.equal(memoCountAToB, 0);
    });

    it("swap_v2: with memo", async () => {
      await enableRequiredMemoTransfers(provider, tokenAccountA);
      await enableRequiredMemoTransfers(provider, tokenAccountB);
      assert.ok(await isRequiredMemoTransfersEnabled(provider, tokenAccountA));
      assert.ok(await isRequiredMemoTransfersEnabled(provider, tokenAccountB));

      const balanceA0 = new BN(await getTokenBalance(provider, tokenAccountA));
      const balanceB0 = new BN(await getTokenBalance(provider, tokenAccountB));

      const sigBToA = await toTx(
        ctx,
        WhirlpoolIx.swapV2Ix(ctx.program, {
          ...quoteBToA,
          whirlpool: whirlpoolPda.publicKey,
          tokenAuthority: ctx.wallet.publicKey,
          tokenMintA: poolInitInfo.tokenMintA,
          tokenMintB: poolInitInfo.tokenMintB,
          tokenProgramA: poolInitInfo.tokenProgramA,
          tokenProgramB: poolInitInfo.tokenProgramB,
          tokenOwnerAccountA: tokenAccountA,
          tokenVaultA: poolInitInfo.tokenVaultAKeypair.publicKey,
          tokenOwnerAccountB: tokenAccountB,
          tokenVaultB: poolInitInfo.tokenVaultBKeypair.publicKey,
          oracle: oraclePubkey,
        }),
      ).buildAndExecute();

      const balanceA1 = new BN(await getTokenBalance(provider, tokenAccountA));
      const balanceB1 = new BN(await getTokenBalance(provider, tokenAccountB));
      assert.ok(balanceB1.lt(balanceB0));
      assert.ok(balanceA1.gt(balanceA0));

      const memoCountBToA = await countMemoLog(
        provider,
        sigBToA,
        MEMO_TRANSFER_SWAP,
      );
      assert.equal(memoCountBToA, 1);

      const sigAToB = await toTx(
        ctx,
        WhirlpoolIx.swapV2Ix(ctx.program, {
          ...quoteAToB,
          whirlpool: whirlpoolPda.publicKey,
          tokenAuthority: ctx.wallet.publicKey,
          tokenMintA: poolInitInfo.tokenMintA,
          tokenMintB: poolInitInfo.tokenMintB,
          tokenProgramA: poolInitInfo.tokenProgramA,
          tokenProgramB: poolInitInfo.tokenProgramB,
          tokenOwnerAccountA: tokenAccountA,
          tokenVaultA: poolInitInfo.tokenVaultAKeypair.publicKey,
          tokenOwnerAccountB: tokenAccountB,
          tokenVaultB: poolInitInfo.tokenVaultBKeypair.publicKey,
          oracle: oraclePubkey,
        }),
      ).buildAndExecute();

      const balanceA2 = new BN(await getTokenBalance(provider, tokenAccountA));
      const balanceB2 = new BN(await getTokenBalance(provider, tokenAccountB));
      assert.ok(balanceA2.lt(balanceA1));
      assert.ok(balanceB2.gt(balanceB1));

      const memoCountAToB = await countMemoLog(
        provider,
        sigAToB,
        MEMO_TRANSFER_SWAP,
      );
      assert.equal(memoCountAToB, 1);
    });

    it("swap_v2: without memo (has extension, but disabled", async () => {
      await enableRequiredMemoTransfers(provider, tokenAccountA);
      await enableRequiredMemoTransfers(provider, tokenAccountB);
      assert.ok(await isRequiredMemoTransfersEnabled(provider, tokenAccountA));
      assert.ok(await isRequiredMemoTransfersEnabled(provider, tokenAccountB));

      await disableRequiredMemoTransfers(provider, tokenAccountA);
      await disableRequiredMemoTransfers(provider, tokenAccountB);
      assert.ok(
        !(await isRequiredMemoTransfersEnabled(provider, tokenAccountA)),
      );
      assert.ok(
        !(await isRequiredMemoTransfersEnabled(provider, tokenAccountB)),
      );

      const balanceA0 = new BN(await getTokenBalance(provider, tokenAccountA));
      const balanceB0 = new BN(await getTokenBalance(provider, tokenAccountB));

      const sigBToA = await toTx(
        ctx,
        WhirlpoolIx.swapV2Ix(ctx.program, {
          ...quoteBToA,
          whirlpool: whirlpoolPda.publicKey,
          tokenAuthority: ctx.wallet.publicKey,
          tokenMintA: poolInitInfo.tokenMintA,
          tokenMintB: poolInitInfo.tokenMintB,
          tokenProgramA: poolInitInfo.tokenProgramA,
          tokenProgramB: poolInitInfo.tokenProgramB,
          tokenOwnerAccountA: tokenAccountA,
          tokenVaultA: poolInitInfo.tokenVaultAKeypair.publicKey,
          tokenOwnerAccountB: tokenAccountB,
          tokenVaultB: poolInitInfo.tokenVaultBKeypair.publicKey,
          oracle: oraclePubkey,
        }),
      ).buildAndExecute();

      const balanceA1 = new BN(await getTokenBalance(provider, tokenAccountA));
      const balanceB1 = new BN(await getTokenBalance(provider, tokenAccountB));
      assert.ok(balanceB1.lt(balanceB0));
      assert.ok(balanceA1.gt(balanceA0));

      const memoCountBToA = await countMemoLog(
        provider,
        sigBToA,
        MEMO_TRANSFER_SWAP,
      );
      assert.equal(memoCountBToA, 0);

      const sigAToB = await toTx(
        ctx,
        WhirlpoolIx.swapV2Ix(ctx.program, {
          ...quoteAToB,
          whirlpool: whirlpoolPda.publicKey,
          tokenAuthority: ctx.wallet.publicKey,
          tokenMintA: poolInitInfo.tokenMintA,
          tokenMintB: poolInitInfo.tokenMintB,
          tokenProgramA: poolInitInfo.tokenProgramA,
          tokenProgramB: poolInitInfo.tokenProgramB,
          tokenOwnerAccountA: tokenAccountA,
          tokenVaultA: poolInitInfo.tokenVaultAKeypair.publicKey,
          tokenOwnerAccountB: tokenAccountB,
          tokenVaultB: poolInitInfo.tokenVaultBKeypair.publicKey,
          oracle: oraclePubkey,
        }),
      ).buildAndExecute();

      const balanceA2 = new BN(await getTokenBalance(provider, tokenAccountA));
      const balanceB2 = new BN(await getTokenBalance(provider, tokenAccountB));
      assert.ok(balanceA2.lt(balanceA1));
      assert.ok(balanceB2.gt(balanceB1));

      const memoCountAToB = await countMemoLog(
        provider,
        sigAToB,
        MEMO_TRANSFER_SWAP,
      );
      assert.equal(memoCountAToB, 0);
    });
  });

  describe("two_hop_swap", () => {
    let aqConfig: InitAquariumV2Params;
    let baseIxParams: TwoHopSwapV2Params;
    let tokenAccountIn: PublicKey;
    let tokenAccountOut: PublicKey;

    beforeEach(async () => {
      aqConfig = getDefaultAquariumV2();
      // Add a third token and account and a second pool
      aqConfig.initMintParams = [
        { tokenTrait: { isToken2022: true } },
        { tokenTrait: { isToken2022: true } },
        { tokenTrait: { isToken2022: true } },
      ];
      aqConfig.initTokenAccParams.push({ mintIndex: 2 });
      aqConfig.initPoolParams.push({
        mintIndices: [1, 2],
        tickSpacing: TickSpacing.Standard,
      });

      // Add tick arrays and positions
      const aToB = false;
      aqConfig.initTickArrayRangeParams.push({
        poolIndex: 0,
        startTickIndex: 22528,
        arrayCount: 3,
        aToB,
      });
      aqConfig.initTickArrayRangeParams.push({
        poolIndex: 1,
        startTickIndex: 22528,
        arrayCount: 3,
        aToB,
      });
      const fundParams: FundedPositionV2Params[] = [
        {
          liquidityAmount: new anchor.BN(10_000_000),
          tickLowerIndex: 29440,
          tickUpperIndex: 33536,
        },
      ];
      aqConfig.initPositionParams.push({ poolIndex: 0, fundParams });
      aqConfig.initPositionParams.push({ poolIndex: 1, fundParams });

      const aquarium = (await buildTestAquariumsV2(ctx, [aqConfig]))[0];
      const { tokenAccounts, mintKeys, pools } = aquarium;

      const whirlpoolOneKey = pools[0].whirlpoolPda.publicKey;
      const whirlpoolTwoKey = pools[1].whirlpoolPda.publicKey;
      const whirlpoolDataOne = (await fetcher.getPool(
        whirlpoolOneKey,
        IGNORE_CACHE,
      )) as WhirlpoolData;
      const whirlpoolDataTwo = (await fetcher.getPool(
        whirlpoolTwoKey,
        IGNORE_CACHE,
      )) as WhirlpoolData;

      const [inputToken, intermediaryToken, _outputToken] = mintKeys;
      const aToBOne = whirlpoolDataOne.tokenMintA.equals(inputToken);
      const quote = swapQuoteWithParams(
        {
          amountSpecifiedIsInput: true,
          aToB: aToBOne,
          tokenAmount: new BN(1000),
          otherAmountThreshold: SwapUtils.getDefaultOtherAmountThreshold(true),
          sqrtPriceLimit: SwapUtils.getDefaultSqrtPriceLimit(aToBOne),
          whirlpoolData: whirlpoolDataOne,
          tickArrays: await SwapUtils.getTickArrays(
            whirlpoolDataOne.tickCurrentIndex,
            whirlpoolDataOne.tickSpacing,
            aToBOne,
            ctx.program.programId,
            whirlpoolOneKey,
            fetcher,
            IGNORE_CACHE,
          ),
          tokenExtensionCtx:
            await TokenExtensionUtil.buildTokenExtensionContext(
              fetcher,
              whirlpoolDataOne,
              IGNORE_CACHE,
            ),
          oracleData: NO_ORACLE_DATA,
        },
        Percentage.fromFraction(1, 100),
      );

      const aToBTwo = whirlpoolDataTwo.tokenMintA.equals(intermediaryToken);
      const quote2 = swapQuoteWithParams(
        {
          amountSpecifiedIsInput: true,
          aToB: aToBTwo,
          tokenAmount: quote.estimatedAmountOut,
          otherAmountThreshold: SwapUtils.getDefaultOtherAmountThreshold(true),
          sqrtPriceLimit: SwapUtils.getDefaultSqrtPriceLimit(aToBTwo),
          whirlpoolData: whirlpoolDataTwo,
          tickArrays: await SwapUtils.getTickArrays(
            whirlpoolDataTwo.tickCurrentIndex,
            whirlpoolDataTwo.tickSpacing,
            aToBTwo,
            ctx.program.programId,
            whirlpoolTwoKey,
            fetcher,
            IGNORE_CACHE,
          ),
          tokenExtensionCtx:
            await TokenExtensionUtil.buildTokenExtensionContext(
              fetcher,
              whirlpoolDataTwo,
              IGNORE_CACHE,
            ),
          oracleData: NO_ORACLE_DATA,
        },
        Percentage.fromFraction(1, 100),
      );

      const tokenAccKeys = getTokenAccsForPoolsV2(pools, tokenAccounts);
      const twoHopQuote = twoHopSwapQuoteFromSwapQuotes(quote, quote2);
      baseIxParams = {
        ...twoHopQuote,
        tokenAuthority: ctx.wallet.publicKey,
        whirlpoolOne: pools[0].whirlpoolPda.publicKey,
        whirlpoolTwo: pools[1].whirlpoolPda.publicKey,
        tokenMintInput: twoHopQuote.aToBOne
          ? pools[0].tokenMintA
          : pools[0].tokenMintB,
        tokenMintIntermediate: twoHopQuote.aToBOne
          ? pools[0].tokenMintB
          : pools[0].tokenMintA,
        tokenMintOutput: twoHopQuote.aToBTwo
          ? pools[1].tokenMintB
          : pools[1].tokenMintA,
        tokenProgramInput: twoHopQuote.aToBOne
          ? pools[0].tokenProgramA
          : pools[0].tokenProgramB,
        tokenProgramIntermediate: twoHopQuote.aToBOne
          ? pools[0].tokenProgramB
          : pools[0].tokenProgramA,
        tokenProgramOutput: twoHopQuote.aToBTwo
          ? pools[1].tokenProgramB
          : pools[1].tokenProgramA,
        tokenOwnerAccountInput: twoHopQuote.aToBOne
          ? tokenAccKeys[0]
          : tokenAccKeys[1],
        tokenOwnerAccountOutput: twoHopQuote.aToBTwo
          ? tokenAccKeys[3]
          : tokenAccKeys[2],
        tokenVaultOneInput: twoHopQuote.aToBOne
          ? pools[0].tokenVaultAKeypair.publicKey
          : pools[0].tokenVaultBKeypair.publicKey,
        tokenVaultOneIntermediate: twoHopQuote.aToBOne
          ? pools[0].tokenVaultBKeypair.publicKey
          : pools[0].tokenVaultAKeypair.publicKey,
        tokenVaultTwoIntermediate: twoHopQuote.aToBTwo
          ? pools[1].tokenVaultAKeypair.publicKey
          : pools[1].tokenVaultBKeypair.publicKey,
        tokenVaultTwoOutput: twoHopQuote.aToBTwo
          ? pools[1].tokenVaultBKeypair.publicKey
          : pools[1].tokenVaultAKeypair.publicKey,
        oracleOne: PDAUtil.getOracle(
          ctx.program.programId,
          pools[0].whirlpoolPda.publicKey,
        ).publicKey,
        oracleTwo: PDAUtil.getOracle(
          ctx.program.programId,
          pools[1].whirlpoolPda.publicKey,
        ).publicKey,
      };

      tokenAccountIn = baseIxParams.tokenOwnerAccountInput;
      tokenAccountOut = baseIxParams.tokenOwnerAccountOutput;
    });

    it("two_hop_swap_v2: without memo", async () => {
      const preBalanceIn = new BN(
        await getTokenBalance(provider, tokenAccountIn),
      );
      const preBalanceOut = new BN(
        await getTokenBalance(provider, tokenAccountOut),
      );

      const sig = await toTx(
        ctx,
        WhirlpoolIx.twoHopSwapV2Ix(ctx.program, baseIxParams),
      ).buildAndExecute();

      const postBalanceIn = new BN(
        await getTokenBalance(provider, tokenAccountIn),
      );
      const postBalanceOut = new BN(
        await getTokenBalance(provider, tokenAccountOut),
      );
      assert.ok(postBalanceIn.lt(preBalanceIn));
      assert.ok(postBalanceOut.gt(preBalanceOut));

      const memoCount = await countMemoLog(provider, sig, MEMO_TRANSFER_SWAP);
      assert.equal(memoCount, 0);
    });

    it("two_hop_swap_v2: with memo", async () => {
      await enableRequiredMemoTransfers(provider, tokenAccountIn);
      await enableRequiredMemoTransfers(provider, tokenAccountOut);
      assert.ok(await isRequiredMemoTransfersEnabled(provider, tokenAccountIn));
      assert.ok(
        await isRequiredMemoTransfersEnabled(provider, tokenAccountOut),
      );

      const preBalanceIn = new BN(
        await getTokenBalance(provider, tokenAccountIn),
      );
      const preBalanceOut = new BN(
        await getTokenBalance(provider, tokenAccountOut),
      );

      const sig = await toTx(
        ctx,
        WhirlpoolIx.twoHopSwapV2Ix(ctx.program, baseIxParams),
      ).buildAndExecute();

      const postBalanceIn = new BN(
        await getTokenBalance(provider, tokenAccountIn),
      );
      const postBalanceOut = new BN(
        await getTokenBalance(provider, tokenAccountOut),
      );
      assert.ok(postBalanceIn.lt(preBalanceIn));
      assert.ok(postBalanceOut.gt(preBalanceOut));

      const memoCount = await countMemoLog(provider, sig, MEMO_TRANSFER_SWAP);
      assert.equal(memoCount, 1); // mid token uses vault to vault transfer, so no memo
    });

    it("two_hop_swap_v2: without memo (has extension, but disabled", async () => {
      await enableRequiredMemoTransfers(provider, tokenAccountIn);
      await enableRequiredMemoTransfers(provider, tokenAccountOut);
      assert.ok(await isRequiredMemoTransfersEnabled(provider, tokenAccountIn));
      assert.ok(
        await isRequiredMemoTransfersEnabled(provider, tokenAccountOut),
      );

      await disableRequiredMemoTransfers(provider, tokenAccountIn);
      await disableRequiredMemoTransfers(provider, tokenAccountOut);
      assert.ok(
        !(await isRequiredMemoTransfersEnabled(provider, tokenAccountIn)),
      );
      assert.ok(
        !(await isRequiredMemoTransfersEnabled(provider, tokenAccountOut)),
      );

      const preBalanceIn = new BN(
        await getTokenBalance(provider, tokenAccountIn),
      );
      const preBalanceOut = new BN(
        await getTokenBalance(provider, tokenAccountOut),
      );

      const sig = await toTx(
        ctx,
        WhirlpoolIx.twoHopSwapV2Ix(ctx.program, baseIxParams),
      ).buildAndExecute();

      const postBalanceIn = new BN(
        await getTokenBalance(provider, tokenAccountIn),
      );
      const postBalanceOut = new BN(
        await getTokenBalance(provider, tokenAccountOut),
      );
      assert.ok(postBalanceIn.lt(preBalanceIn));
      assert.ok(postBalanceOut.gt(preBalanceOut));

      const memoCount = await countMemoLog(provider, sig, MEMO_TRANSFER_SWAP);
      assert.equal(memoCount, 0);
    });
  });
});

async function countMemoLog(
  provider: anchor.AnchorProvider,
  signature: string,
  logMessage: string,
): Promise<number> {
  const logLen = logMessage.length;
  const logFormat = `Program log: Memo (len ${logLen}): "${logMessage}"`;

  const tx = await provider.connection.getParsedTransaction(signature, {
    maxSupportedTransactionVersion: 0,
  });
  const memos = tx?.meta?.logMessages?.filter((msg) => msg === logFormat);
  return memos!.length;
}
