import type { Program } from "@coral-xyz/anchor";
import type { Instruction } from "@orca-so/common-sdk";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import type { PublicKey } from "@solana/web3.js";
import type BN from "bn.js";
import type { Whirlpool } from "../artifacts/whirlpool";
import invariant from "tiny-invariant";

/**
 * Parameters to execute a two-hop swap on a Whirlpool.
 *
 * @category Instruction Types
 * @param whirlpoolOne - PublicKey for the whirlpool that the swap-one will occur on
 * @param whirlpoolTwo - PublicKey for the whirlpool that the swap-two will occur on
 * @param tokenOwnerAccountOneA - PublicKey for the associated token account for tokenA in whirlpoolOne in the collection wallet
 * @param tokenOwnerAccountOneB - PublicKey for the associated token account for tokenB in whirlpoolOne in the collection wallet
 * @param tokenOwnerAccountTwoA - PublicKey for the associated token account for tokenA in whirlpoolTwo in the collection wallet
 * @param tokenOwnerAccountTwoB - PublicKey for the associated token account for tokenB in whirlpoolTwo in the collection wallet
 * @param tokenVaultOneA - PublicKey for the tokenA vault for whirlpoolOne.
 * @param tokenVaultOneB - PublicKey for the tokenB vault for whirlpoolOne.
 * @param tokenVaultTwoA - PublicKey for the tokenA vault for whirlpoolTwo.
 * @param tokenVaultTwoB - PublicKey for the tokenB vault for whirlpoolTwo.
 * @param oracleOne - PublicKey for the oracle account for this whirlpoolOne.
 * @param oracleTwo - PublicKey for the oracle account for this whirlpoolTwo.
 * @param tokenAuthority - authority to withdraw tokens from the input token account
 * @param swapInput - Parameters in {@link TwoHopSwapInput}
 */
export type TwoHopSwapParams = TwoHopSwapInput & {
  whirlpoolOne: PublicKey;
  whirlpoolTwo: PublicKey;
  tokenOwnerAccountOneA: PublicKey;
  tokenOwnerAccountOneB: PublicKey;
  tokenOwnerAccountTwoA: PublicKey;
  tokenOwnerAccountTwoB: PublicKey;
  tokenVaultOneA: PublicKey;
  tokenVaultOneB: PublicKey;
  tokenVaultTwoA: PublicKey;
  tokenVaultTwoB: PublicKey;
  oracleOne: PublicKey;
  oracleTwo: PublicKey;
  tokenAuthority: PublicKey;
};

/**
 * Parameters that define a two-hop swap on a Whirlpool.
 *
 * @category Instruction Types
 * @param amount - The amount of input or output token to swap from (depending on amountSpecifiedIsInput).
 * @param otherAmountThreshold - The maximum/minimum of input/output token to swap into (depending on amountSpecifiedIsInput).
 * @param amountSpecifiedIsInput - Specifies the token the paramneter `amount`represets. If true, the amount represents
 *                                 the input token of the swap.
 * @param aToBOne - The direction of the swap-one. True if swapping from A to B. False if swapping from B to A.
 * @param aToBTwo - The direction of the swap-two. True if swapping from A to B. False if swapping from B to A.
 * @param sqrtPriceLimitOne - The maximum/minimum price that swap-one will swap to.
 * @param sqrtPriceLimitTwo - The maximum/minimum price that swap-two will swap to.
 * @param tickArrayOne0 - PublicKey of the tick-array of swap-One where the Whirlpool's currentTickIndex resides in
 * @param tickArrayOne1 - The next tick-array in the swap direction of swap-One. If the swap will not reach the next tick-aray, input the same array as tickArray0.
 * @param tickArrayOne2 - The next tick-array in the swap direction after tickArray2 of swap-One. If the swap will not reach the next tick-aray, input the same array as tickArray1.
 * @param tickArrayTwo0 - PublicKey of the tick-array of swap-Two where the Whirlpool's currentTickIndex resides in
 * @param tickArrayTwo1 - The next tick-array in the swap direction of swap-Two. If the swap will not reach the next tick-aray, input the same array as tickArray0.
 * @param tickArrayTwo2 - The next tick-array in the swap direction after tickArray2 of swap-Two. If the swap will not reach the next tick-aray, input the same array as tickArray1.
 * @param supplementalTickArraysOne - (V2 only) Optional array of PublicKey for supplemental tick arrays of whirlpoolOne. twoHopSwap instruction will ignore this parameter.
 * @param supplementalTickArraysTwo - (V2 only) Optional array of PublicKey for supplemental tick arrays of whirlpoolTwo. twoHopSwap instruction will ignore this parameter.
 */
export type TwoHopSwapInput = {
  amount: BN;
  otherAmountThreshold: BN;
  amountSpecifiedIsInput: boolean;
  aToBOne: boolean;
  aToBTwo: boolean;
  sqrtPriceLimitOne: BN;
  sqrtPriceLimitTwo: BN;
  tickArrayOne0: PublicKey;
  tickArrayOne1: PublicKey;
  tickArrayOne2: PublicKey;
  tickArrayTwo0: PublicKey;
  tickArrayTwo1: PublicKey;
  tickArrayTwo2: PublicKey;
  supplementalTickArraysOne?: PublicKey[];
  supplementalTickArraysTwo?: PublicKey[];
};

/**
 * Perform a two-hop swap in this Whirlpool
 *
 * #### Special Errors
 * - `ZeroTradableAmount` - User provided parameter `amount` is 0.
 * - `InvalidSqrtPriceLimitDirection` - User provided parameter `sqrt_price_limit` does not match the direction of the trade.
 * - `SqrtPriceOutOfBounds` - User provided parameter `sqrt_price_limit` is over Whirlppool's max/min bounds for sqrt-price.
 * - `InvalidTickArraySequence` - User provided tick-arrays are not in sequential order required to proceed in this trade direction.
 * - `TickArraySequenceInvalidIndex` - The swap loop attempted to access an invalid array index during the query of the next initialized tick.
 * - `TickArrayIndexOutofBounds` - The swap loop attempted to access an invalid array index during tick crossing.
 * - `LiquidityOverflow` - Liquidity value overflowed 128bits during tick crossing.
 * - `InvalidTickSpacing` - The swap pool was initialized with tick-spacing of 0.
 * - `InvalidIntermediaryMint` - Error if the intermediary mint between hop one and two do not equal.
 * - `DuplicateTwoHopPool` - Error if whirlpool one & two are the same pool.
 * - `AmountCalcOverflow` - The required token amount exceeds the u64 range.
 * - `AmountRemainingOverflow` - Result does not match the specified amount.
 * - `DifferentWhirlpoolTickArrayAccount` - The provided tick array account does not belong to the whirlpool.
 * - `PartialFillError` - Partially filled when sqrtPriceLimit = 0 and amountSpecifiedIsInput = false.
 * - `IntermediateTokenAmountMismatch` - The amount of tokens received from the first hop does not match the amount sent to the second hop.
 *
 * ### Parameters
 * @category Instructions
 * @param context - Context object containing services required to generate the instruction
 * @param params - {@link TwoHopSwapParams} object
 * @returns - Instruction to perform the action.
 */
export function twoHopSwapIx(
  program: Program<Whirlpool>,
  params: TwoHopSwapParams,
): Instruction {
  const {
    amount,
    otherAmountThreshold,
    amountSpecifiedIsInput,
    aToBOne,
    aToBTwo,
    sqrtPriceLimitOne,
    sqrtPriceLimitTwo,
    whirlpoolOne,
    whirlpoolTwo,
    tokenAuthority,
    tokenOwnerAccountOneA,
    tokenVaultOneA,
    tokenOwnerAccountOneB,
    tokenVaultOneB,
    tokenOwnerAccountTwoA,
    tokenVaultTwoA,
    tokenOwnerAccountTwoB,
    tokenVaultTwoB,
    tickArrayOne0,
    tickArrayOne1,
    tickArrayOne2,
    tickArrayTwo0,
    tickArrayTwo1,
    tickArrayTwo2,
    oracleOne,
    oracleTwo,
  } = params;

  const ix = program.instruction.twoHopSwap(
    amount,
    otherAmountThreshold,
    amountSpecifiedIsInput,
    aToBOne,
    aToBTwo,
    sqrtPriceLimitOne,
    sqrtPriceLimitTwo,
    {
      accounts: {
        tokenProgram: TOKEN_PROGRAM_ID,
        tokenAuthority,
        whirlpoolOne,
        whirlpoolTwo,
        tokenOwnerAccountOneA,
        tokenVaultOneA,
        tokenOwnerAccountOneB,
        tokenVaultOneB,
        tokenOwnerAccountTwoA,
        tokenVaultTwoA,
        tokenOwnerAccountTwoB,
        tokenVaultTwoB,
        tickArrayOne0,
        tickArrayOne1,
        tickArrayOne2,
        tickArrayTwo0,
        tickArrayTwo1,
        tickArrayTwo2,
        oracleOne,
        oracleTwo,
      },
    },
  );

  // HACK: to make Oracle account mutable without breaking change
  // The official way to assemble instructions for pools that use AdaptiveFee is to add remaining accounts with isWritable set to true,
  // but this hack that overrides the IDL requirements works.
  invariant(ix.keys[18].pubkey.equals(oracleOne));
  ix.keys[18].isWritable = true;
  invariant(ix.keys[19].pubkey.equals(oracleTwo));
  ix.keys[19].isWritable = true;

  return {
    instructions: [ix],
    cleanupInstructions: [],
    signers: [],
  };
}
