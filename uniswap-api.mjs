/**
 * uniswap-api.mjs — server-side Uniswap V3/V4 data for the trader dashboard
 * Ported from ToknWrks app/(default)/uniswap + API routes.
 *
 * V3 positions + collect fees: work with any Base RPC (no Alchemy key needed)
 * V4 positions + P&L:          require ALCHEMY_API_KEY (Alchemy NFT + Transfer APIs)
 */

import {
  createPublicClient, createWalletClient, http, formatUnits, getAddress,
  keccak256, encodeAbiParameters, decodeEventLog, parseAbiItem,
} from "viem";
import { base, arbitrum, mainnet } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";

// ── Constants ─────────────────────────────────────────────────────────────────

const NPM_ADDRESS    = '0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1';
const FACTORY_ADDRESS = '0x33128a8fC17869897dcE68Ed026d694621f6FDfD';
const V4_PM_ADDRESS  = '0x7c5f5a4bbd8fd63184577525326123b519429bdc';
const V4_STATE_VIEW  = '0xa3c0c9b65bad0b08107aa264b0f3db444b867a71';
const NATIVE_ETH     = '0x0000000000000000000000000000000000000000';
const WETH_BASE      = '0x4200000000000000000000000000000000000006';

// ── RPC ───────────────────────────────────────────────────────────────────────

function getAlchemyUrl() {
  const key = process.env.ALCHEMY_API_KEY;
  return key ? `https://base-mainnet.g.alchemy.com/v2/${key}` : 'https://mainnet.base.org';
}

function createClient() {
  return createPublicClient({ chain: base, transport: http(getAlchemyUrl()) });
}

// ── ABIs ──────────────────────────────────────────────────────────────────────

const NPM_ABI = [
  { name: 'balanceOf', type: 'function', stateMutability: 'view',
    inputs: [{ name: 'owner', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] },
  { name: 'tokenOfOwnerByIndex', type: 'function', stateMutability: 'view',
    inputs: [{ name: 'owner', type: 'address' }, { name: 'index', type: 'uint256' }],
    outputs: [{ name: '', type: 'uint256' }] },
  { name: 'positions', type: 'function', stateMutability: 'view',
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    outputs: [
      { name: 'nonce', type: 'uint96' }, { name: 'operator', type: 'address' },
      { name: 'token0', type: 'address' }, { name: 'token1', type: 'address' },
      { name: 'fee', type: 'uint24' }, { name: 'tickLower', type: 'int24' },
      { name: 'tickUpper', type: 'int24' }, { name: 'liquidity', type: 'uint128' },
      { name: 'feeGrowthInside0LastX128', type: 'uint256' }, { name: 'feeGrowthInside1LastX128', type: 'uint256' },
      { name: 'tokensOwed0', type: 'uint128' }, { name: 'tokensOwed1', type: 'uint128' },
    ] },
];

const COLLECT_ABI = [
  { name: 'collect', type: 'function', stateMutability: 'payable',
    inputs: [{ name: 'params', type: 'tuple', components: [
      { name: 'tokenId', type: 'uint256' }, { name: 'recipient', type: 'address' },
      { name: 'amount0Max', type: 'uint128' }, { name: 'amount1Max', type: 'uint128' },
    ]}],
    outputs: [{ name: 'amount0', type: 'uint256' }, { name: 'amount1', type: 'uint256' }] },
];

const ERC20_ABI = [
  { name: 'symbol', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'string' }] },
  { name: 'decimals', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint8' }] },
];

const FACTORY_ABI = [
  { name: 'getPool', type: 'function', stateMutability: 'view',
    inputs: [{ name: 'tokenA', type: 'address' }, { name: 'tokenB', type: 'address' }, { name: 'fee', type: 'uint24' }],
    outputs: [{ name: 'pool', type: 'address' }] },
];

const POOL_ABI = [
  { name: 'slot0', type: 'function', stateMutability: 'view', inputs: [], outputs: [
    { name: 'sqrtPriceX96', type: 'uint160' }, { name: 'tick', type: 'int24' },
    { name: 'observationIndex', type: 'uint16' }, { name: 'observationCardinality', type: 'uint16' },
    { name: 'observationCardinalityNext', type: 'uint16' }, { name: 'feeProtocol', type: 'uint8' },
    { name: 'unlocked', type: 'bool' },
  ]},
  { name: 'feeGrowthGlobal0X128', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint256' }] },
  { name: 'feeGrowthGlobal1X128', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint256' }] },
  { name: 'ticks', type: 'function', stateMutability: 'view',
    inputs: [{ name: 'tick', type: 'int24' }],
    outputs: [
      { name: 'liquidityGross', type: 'uint128' }, { name: 'liquidityNet', type: 'int128' },
      { name: 'feeGrowthOutside0X128', type: 'uint256' }, { name: 'feeGrowthOutside1X128', type: 'uint256' },
      { name: 'tickCumulativeOutside', type: 'int56' }, { name: 'secondsPerLiquidityOutsideX128', type: 'uint160' },
      { name: 'secondsOutside', type: 'uint32' }, { name: 'initialized', type: 'bool' },
    ]},
];

const V4_PM_ABI = [
  { name: 'getPoolAndPositionInfo', type: 'function', stateMutability: 'view',
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    outputs: [
      { name: 'poolKey', type: 'tuple', components: [
        { name: 'currency0', type: 'address' }, { name: 'currency1', type: 'address' },
        { name: 'fee', type: 'uint24' }, { name: 'tickSpacing', type: 'int24' }, { name: 'hooks', type: 'address' },
      ]},
      { name: 'info', type: 'uint256' },
    ]},
  { name: 'getPositionLiquidity', type: 'function', stateMutability: 'view',
    inputs: [{ name: 'tokenId', type: 'uint256' }], outputs: [{ name: 'liquidity', type: 'uint128' }] },
];

const STATE_VIEW_ABI = [
  { name: 'getSlot0', type: 'function', stateMutability: 'view',
    inputs: [{ name: 'poolId', type: 'bytes32' }],
    outputs: [
      { name: 'sqrtPriceX96', type: 'uint160' }, { name: 'tick', type: 'int24' },
      { name: 'protocolFee', type: 'uint24' }, { name: 'lpFee', type: 'uint24' },
    ]},
  { name: 'getFeeGrowthGlobals', type: 'function', stateMutability: 'view',
    inputs: [{ name: 'poolId', type: 'bytes32' }],
    outputs: [{ name: 'feeGrowthGlobal0X128', type: 'uint256' }, { name: 'feeGrowthGlobal1X128', type: 'uint256' }] },
  { name: 'getTickInfo', type: 'function', stateMutability: 'view',
    inputs: [{ name: 'poolId', type: 'bytes32' }, { name: 'tick', type: 'int24' }],
    outputs: [
      { name: 'liquidityGross', type: 'uint128' }, { name: 'liquidityNet', type: 'int128' },
      { name: 'feeGrowthOutside0X128', type: 'uint256' }, { name: 'feeGrowthOutside1X128', type: 'uint256' },
    ]},
  { name: 'getPositionInfo', type: 'function', stateMutability: 'view',
    inputs: [
      { name: 'poolId', type: 'bytes32' }, { name: 'owner', type: 'address' },
      { name: 'tickLower', type: 'int24' }, { name: 'tickUpper', type: 'int24' }, { name: 'salt', type: 'bytes32' },
    ],
    outputs: [
      { name: 'liquidity', type: 'uint128' }, { name: 'feeGrowthInside0LastX128', type: 'uint256' },
      { name: 'feeGrowthInside1LastX128', type: 'uint256' },
    ]},
];

// ── Shared math ───────────────────────────────────────────────────────────────

function tickToPrice(tick, decimals0, decimals1) {
  return Math.pow(1.0001, tick) * Math.pow(10, decimals0 - decimals1);
}

function formatFee(fee) {
  return `${(fee / 10000).toFixed(2)}%`;
}

function calcAccruedFees(liquidity, feeGrowthGlobal, fgoLower, fgoUpper, fgiLast, tokensOwed, currentTick, tickLower, tickUpper) {
  const M = 2n ** 256n;
  const Q128 = 2n ** 128n;
  const sub = (a, b) => ((a - b) % M + M) % M;
  const feeGrowthBelow = currentTick >= tickLower ? fgoLower : sub(feeGrowthGlobal, fgoLower);
  const feeGrowthAbove = currentTick < tickUpper ? fgoUpper : sub(feeGrowthGlobal, fgoUpper);
  const feeGrowthInside = sub(sub(feeGrowthGlobal, feeGrowthBelow), feeGrowthAbove);
  return liquidity * sub(feeGrowthInside, fgiLast) / Q128 + tokensOwed;
}

function getTokenAmounts(sqrtPriceX96, tickLower, tickUpper, liquidity, decimals0, decimals1) {
  const sqrtPrice = Number(sqrtPriceX96) / Math.pow(2, 96);
  const sqrtPriceA = Math.pow(1.0001, tickLower / 2);
  const sqrtPriceB = Math.pow(1.0001, tickUpper / 2);
  const L = Number(liquidity);
  let amount0 = 0, amount1 = 0;
  if (sqrtPrice <= sqrtPriceA) {
    amount0 = L * (1 / sqrtPriceA - 1 / sqrtPriceB);
  } else if (sqrtPrice < sqrtPriceB) {
    amount0 = L * (1 / sqrtPrice - 1 / sqrtPriceB);
    amount1 = L * (sqrtPrice - sqrtPriceA);
  } else {
    amount1 = L * (sqrtPriceB - sqrtPriceA);
  }
  return { amount0: amount0 / Math.pow(10, decimals0), amount1: amount1 / Math.pow(10, decimals1) };
}

function getPoolId(currency0, currency1, fee, tickSpacing, hooks) {
  return keccak256(encodeAbiParameters(
    [{ type: 'address' }, { type: 'address' }, { type: 'uint24' }, { type: 'int24' }, { type: 'address' }],
    [currency0, currency1, fee, tickSpacing, hooks],
  ));
}

// ── Pricing ───────────────────────────────────────────────────────────────────

async function getDeFiLlamaPrices(addrs) {
  const keys = [...new Set(addrs.map(a => `base:${a.toLowerCase()}`))];
  try {
    const res = await fetch(`https://coins.llama.fi/prices/current/${keys.join(',')}`);
    if (!res.ok) return {};
    const data = await res.json();
    const out = {};
    for (const [k, v] of Object.entries(data.coins ?? {})) out[k.replace('base:', '')] = v.price;
    return out;
  } catch { return {}; }
}

async function getHistoricalPrices(timestamp, token0, token1) {
  const t0 = token0.toLowerCase() === NATIVE_ETH ? WETH_BASE.toLowerCase() : token0.toLowerCase();
  const t1 = token1.toLowerCase() === NATIVE_ETH ? WETH_BASE.toLowerCase() : token1.toLowerCase();
  const keys = [...new Set([`base:${t0}`, `base:${t1}`])];
  try {
    const res = await fetch(`https://coins.llama.fi/prices/historical/${timestamp}/${keys.join(',')}`);
    if (!res.ok) return { price0: null, price1: null };
    const data = await res.json();
    const prices = {};
    for (const [k, v] of Object.entries(data.coins ?? {})) prices[k] = v.price;
    return { price0: prices[`base:${t0}`] ?? null, price1: prices[`base:${t1}`] ?? null };
  } catch { return { price0: null, price1: null }; }
}

// ── V3 Positions ──────────────────────────────────────────────────────────────

export async function getV3Positions(walletAddress) {
  const address = getAddress(walletAddress);
  const client = createClient();
  const ZERO = '0x0000000000000000000000000000000000000000';

  const balance = await client.readContract({ address: NPM_ADDRESS, abi: NPM_ABI, functionName: 'balanceOf', args: [address] });
  if (balance === 0n) return { positions: [] };

  const tokenIdResults = await client.multicall({
    contracts: Array.from({ length: Number(balance) }, (_, i) => ({
      address: NPM_ADDRESS, abi: NPM_ABI, functionName: 'tokenOfOwnerByIndex', args: [address, BigInt(i)],
    })),
  });
  const tokenIds = tokenIdResults.map(r => r.status === 'success' ? r.result : null).filter(Boolean);

  const positionResults = await client.multicall({
    contracts: tokenIds.map(tokenId => ({ address: NPM_ADDRESS, abi: NPM_ABI, functionName: 'positions', args: [tokenId] })),
  });
  const rawPositions = positionResults
    .map((r, i) => r.status === 'success' ? { tokenId: tokenIds[i], data: r.result } : null)
    .filter(Boolean);

  const uniqueTokens = [...new Set(rawPositions.flatMap(p => [p.data[2], p.data[3]]))];
  const tokenMetaResults = await client.multicall({
    contracts: uniqueTokens.flatMap(addr => [
      { address: addr, abi: ERC20_ABI, functionName: 'symbol' },
      { address: addr, abi: ERC20_ABI, functionName: 'decimals' },
    ]),
  });
  const tokenMeta = {};
  uniqueTokens.forEach((addr, i) => {
    tokenMeta[addr.toLowerCase()] = {
      symbol: tokenMetaResults[i * 2].status === 'success' ? tokenMetaResults[i * 2].result : '???',
      decimals: tokenMetaResults[i * 2 + 1].status === 'success' ? tokenMetaResults[i * 2 + 1].result : 18,
    };
  });

  const poolResults = await client.multicall({
    contracts: rawPositions.map(p => ({ address: FACTORY_ADDRESS, abi: FACTORY_ABI, functionName: 'getPool', args: [p.data[2], p.data[3], p.data[4]] })),
  });
  const poolAddresses = poolResults.map(r => r.status === 'success' ? r.result : ZERO);

  const poolDataResults = await client.multicall({
    contracts: rawPositions.flatMap((p, i) => {
      const poolAddr = poolAddresses[i];
      const [,,,,,tickLower,tickUpper] = p.data;
      return [
        { address: poolAddr, abi: POOL_ABI, functionName: 'slot0' },
        { address: poolAddr, abi: POOL_ABI, functionName: 'feeGrowthGlobal0X128' },
        { address: poolAddr, abi: POOL_ABI, functionName: 'feeGrowthGlobal1X128' },
        { address: poolAddr, abi: POOL_ABI, functionName: 'ticks', args: [tickLower] },
        { address: poolAddr, abi: POOL_ABI, functionName: 'ticks', args: [tickUpper] },
      ];
    }),
  });

  const usdPrices = await getDeFiLlamaPrices(uniqueTokens);

  const positions = rawPositions.map((p, i) => {
    const [,,token0Addr,token1Addr,fee,tickLower,tickUpper,liquidity,fg0Last,fg1Last,owed0,owed1] = p.data;
    const meta0 = tokenMeta[token0Addr.toLowerCase()] ?? { symbol: '???', decimals: 18 };
    const meta1 = tokenMeta[token1Addr.toLowerCase()] ?? { symbol: '???', decimals: 18 };
    const b = i * 5;
    const slot0 = poolDataResults[b].status === 'success' ? poolDataResults[b].result : null;
    const currentTick = slot0 ? slot0[1] : null;
    const sqrtPrice = slot0 ? slot0[0] : null;
    const inRange = currentTick !== null ? currentTick >= tickLower && currentTick < tickUpper : null;
    const fgg0 = poolDataResults[b+1].status === 'success' ? poolDataResults[b+1].result : 0n;
    const fgg1 = poolDataResults[b+2].status === 'success' ? poolDataResults[b+2].result : 0n;
    const tld = poolDataResults[b+3].status === 'success' ? poolDataResults[b+3].result : null;
    const tud = poolDataResults[b+4].status === 'success' ? poolDataResults[b+4].result : null;

    const rawFees0 = currentTick !== null && liquidity > 0n
      ? calcAccruedFees(liquidity, fgg0, tld?.[2] ?? 0n, tud?.[2] ?? 0n, fg0Last, owed0, currentTick, tickLower, tickUpper)
      : owed0;
    const rawFees1 = currentTick !== null && liquidity > 0n
      ? calcAccruedFees(liquidity, fgg1, tld?.[3] ?? 0n, tud?.[3] ?? 0n, fg1Last, owed1, currentTick, tickLower, tickUpper)
      : owed1;

    const fees0 = formatUnits(rawFees0, meta0.decimals);
    const fees1 = formatUnits(rawFees1, meta1.decimals);
    const p0Usd = usdPrices[token0Addr.toLowerCase()] ?? null;
    const p1Usd = usdPrices[token1Addr.toLowerCase()] ?? null;
    const fees0Usd = p0Usd !== null ? parseFloat(fees0) * p0Usd : null;
    const fees1Usd = p1Usd !== null ? parseFloat(fees1) * p1Usd : null;
    const { amount0, amount1 } = sqrtPrice !== null && liquidity > 0n
      ? getTokenAmounts(sqrtPrice, tickLower, tickUpper, liquidity, meta0.decimals, meta1.decimals)
      : { amount0: 0, amount1: 0 };

    return {
      tokenId: p.tokenId.toString(),
      version: 'v3',
      token0: { address: token0Addr, symbol: meta0.symbol, decimals: meta0.decimals, priceUsd: p0Usd },
      token1: { address: token1Addr, symbol: meta1.symbol, decimals: meta1.decimals, priceUsd: p1Usd },
      fee, feeDisplay: formatFee(fee), tickLower, tickUpper,
      priceLower: tickToPrice(tickLower, meta0.decimals, meta1.decimals).toFixed(6),
      priceUpper: tickToPrice(tickUpper, meta0.decimals, meta1.decimals).toFixed(6),
      liquidity: liquidity.toString(), hasLiquidity: liquidity > 0n, inRange,
      fees0, fees1, fees0Usd, fees1Usd,
      totalFeesUsd: fees0Usd !== null && fees1Usd !== null ? fees0Usd + fees1Usd : null,
      amount0, amount1,
      amount0Usd: p0Usd !== null ? amount0 * p0Usd : null,
      amount1Usd: p1Usd !== null ? amount1 * p1Usd : null,
      totalLiquidityUsd: p0Usd !== null && p1Usd !== null ? amount0 * p0Usd + amount1 * p1Usd : null,
      hasFees: rawFees0 > 0n || rawFees1 > 0n,
    };
  });

  return { positions };
}

// ── Multi-chain V3 ───────────────────────────────────────────────────────────

const CHAIN_CONFIG = {
  base: {
    viemChain: base,
    rpc: () => { const k = process.env.ALCHEMY_API_KEY; return k ? `https://base-mainnet.g.alchemy.com/v2/${k}` : 'https://mainnet.base.org'; },
    weth: '0x4200000000000000000000000000000000000006',
    npm: '0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1',
    factory: '0x33128a8fC17869897dcE68Ed026d694621f6FDfD',
    llamaPrefix: 'base',
  },
  arbitrum: {
    viemChain: arbitrum,
    rpc: () => { const k = process.env.ALCHEMY_API_KEY; return k ? `https://arb-mainnet.g.alchemy.com/v2/${k}` : 'https://arb1.arbitrum.io/rpc'; },
    weth: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',
    npm: '0xC36442b4a4522E871399CD717aBDD847Ab11FE88',
    factory: '0x1F98431c8aD98523631AE4a59f267346ea31F984',
    llamaPrefix: 'arbitrum',
  },
  ethereum: {
    viemChain: mainnet,
    rpc: () => { const k = process.env.ALCHEMY_API_KEY; return k ? `https://eth-mainnet.g.alchemy.com/v2/${k}` : 'https://eth.llamarpc.com'; },
    weth: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
    npm: '0xC36442b4a4522E871399CD717aBDD847Ab11FE88',
    factory: '0x1F98431c8aD98523631AE4a59f267346ea31F984',
    llamaPrefix: 'ethereum',
  },
};

async function getDeFiLlamaPricesForChain(addrs, chainPrefix) {
  const keys = [...new Set(addrs.map(a => `${chainPrefix}:${a.toLowerCase()}`))];
  try {
    const res = await fetch(`https://coins.llama.fi/prices/current/${keys.join(',')}`);
    if (!res.ok) return {};
    const data = await res.json();
    const out = {};
    for (const [k, v] of Object.entries(data.coins ?? {})) out[k.replace(`${chainPrefix}:`, '')] = v.price;
    return out;
  } catch { return {}; }
}

export async function getV3PositionsForChain(walletAddress, chainId = 'arbitrum') {
  const cfg = CHAIN_CONFIG[chainId];
  if (!cfg) throw new Error('Unknown chain: ' + chainId);
  const address = getAddress(walletAddress);
  const client = createPublicClient({ chain: cfg.viemChain, transport: http(cfg.rpc()) });
  const ZERO = '0x0000000000000000000000000000000000000000';

  const balance = await client.readContract({ address: cfg.npm, abi: NPM_ABI, functionName: 'balanceOf', args: [address] });
  if (balance === 0n) return { positions: [] };

  const tokenIdResults = await client.multicall({
    contracts: Array.from({ length: Number(balance) }, (_, i) => ({
      address: cfg.npm, abi: NPM_ABI, functionName: 'tokenOfOwnerByIndex', args: [address, BigInt(i)],
    })),
  });
  const tokenIds = tokenIdResults.map(r => r.status === 'success' ? r.result : null).filter(Boolean);

  const positionResults = await client.multicall({
    contracts: tokenIds.map(tokenId => ({ address: cfg.npm, abi: NPM_ABI, functionName: 'positions', args: [tokenId] })),
  });
  const rawPositions = positionResults
    .map((r, i) => r.status === 'success' ? { tokenId: tokenIds[i], data: r.result } : null)
    .filter(Boolean);

  const uniqueTokens = [...new Set(rawPositions.flatMap(p => [p.data[2], p.data[3]]))];
  const tokenMetaResults = await client.multicall({
    contracts: uniqueTokens.flatMap(addr => [
      { address: addr, abi: ERC20_ABI, functionName: 'symbol' },
      { address: addr, abi: ERC20_ABI, functionName: 'decimals' },
    ]),
  });
  const tokenMeta = {};
  uniqueTokens.forEach((addr, i) => {
    tokenMeta[addr.toLowerCase()] = {
      symbol: tokenMetaResults[i * 2].status === 'success' ? tokenMetaResults[i * 2].result : '???',
      decimals: tokenMetaResults[i * 2 + 1].status === 'success' ? tokenMetaResults[i * 2 + 1].result : 18,
    };
  });

  const poolResults = await client.multicall({
    contracts: rawPositions.map(p => ({ address: cfg.factory, abi: FACTORY_ABI, functionName: 'getPool', args: [p.data[2], p.data[3], p.data[4]] })),
  });
  const poolAddresses = poolResults.map(r => r.status === 'success' ? r.result : ZERO);

  const poolDataResults = await client.multicall({
    contracts: rawPositions.flatMap((p, i) => {
      const poolAddr = poolAddresses[i];
      const [,,,,,tickLower,tickUpper] = p.data;
      return [
        { address: poolAddr, abi: POOL_ABI, functionName: 'slot0' },
        { address: poolAddr, abi: POOL_ABI, functionName: 'feeGrowthGlobal0X128' },
        { address: poolAddr, abi: POOL_ABI, functionName: 'feeGrowthGlobal1X128' },
        { address: poolAddr, abi: POOL_ABI, functionName: 'ticks', args: [tickLower] },
        { address: poolAddr, abi: POOL_ABI, functionName: 'ticks', args: [tickUpper] },
      ];
    }),
  });

  const usdPrices = await getDeFiLlamaPricesForChain(uniqueTokens, cfg.llamaPrefix);

  const positions = rawPositions.map((p, i) => {
    const [,,token0Addr,token1Addr,fee,tickLower,tickUpper,liquidity,fg0Last,fg1Last,owed0,owed1] = p.data;
    const meta0 = tokenMeta[token0Addr.toLowerCase()] ?? { symbol: '???', decimals: 18 };
    const meta1 = tokenMeta[token1Addr.toLowerCase()] ?? { symbol: '???', decimals: 18 };
    const b = i * 5;
    const slot0 = poolDataResults[b].status === 'success' ? poolDataResults[b].result : null;
    const currentTick = slot0 ? slot0[1] : null;
    const sqrtPrice = slot0 ? slot0[0] : null;
    const inRange = currentTick !== null ? currentTick >= tickLower && currentTick < tickUpper : null;
    const fgg0 = poolDataResults[b+1].status === 'success' ? poolDataResults[b+1].result : 0n;
    const fgg1 = poolDataResults[b+2].status === 'success' ? poolDataResults[b+2].result : 0n;
    const tld = poolDataResults[b+3].status === 'success' ? poolDataResults[b+3].result : null;
    const tud = poolDataResults[b+4].status === 'success' ? poolDataResults[b+4].result : null;

    const rawFees0 = currentTick !== null && liquidity > 0n
      ? calcAccruedFees(liquidity, fgg0, tld?.[2] ?? 0n, tud?.[2] ?? 0n, fg0Last, owed0, currentTick, tickLower, tickUpper)
      : owed0;
    const rawFees1 = currentTick !== null && liquidity > 0n
      ? calcAccruedFees(liquidity, fgg1, tld?.[3] ?? 0n, tud?.[3] ?? 0n, fg1Last, owed1, currentTick, tickLower, tickUpper)
      : owed1;

    const fees0 = formatUnits(rawFees0, meta0.decimals);
    const fees1 = formatUnits(rawFees1, meta1.decimals);
    const p0Usd = usdPrices[token0Addr.toLowerCase()] ?? null;
    const p1Usd = usdPrices[token1Addr.toLowerCase()] ?? null;
    const fees0Usd = p0Usd !== null ? parseFloat(fees0) * p0Usd : null;
    const fees1Usd = p1Usd !== null ? parseFloat(fees1) * p1Usd : null;
    const { amount0, amount1 } = sqrtPrice !== null && liquidity > 0n
      ? getTokenAmounts(sqrtPrice, tickLower, tickUpper, liquidity, meta0.decimals, meta1.decimals)
      : { amount0: 0, amount1: 0 };

    return {
      tokenId: p.tokenId.toString(),
      version: 'v3', chain: chainId,
      token0: { address: token0Addr, symbol: meta0.symbol, decimals: meta0.decimals, priceUsd: p0Usd },
      token1: { address: token1Addr, symbol: meta1.symbol, decimals: meta1.decimals, priceUsd: p1Usd },
      fee, feeDisplay: formatFee(fee), tickLower, tickUpper,
      priceLower: tickToPrice(tickLower, meta0.decimals, meta1.decimals).toFixed(6),
      priceUpper: tickToPrice(tickUpper, meta0.decimals, meta1.decimals).toFixed(6),
      liquidity: liquidity.toString(), hasLiquidity: liquidity > 0n, inRange,
      fees0, fees1, fees0Usd, fees1Usd,
      totalFeesUsd: fees0Usd !== null && fees1Usd !== null ? fees0Usd + fees1Usd : null,
      amount0, amount1,
      amount0Usd: p0Usd !== null ? amount0 * p0Usd : null,
      amount1Usd: p1Usd !== null ? amount1 * p1Usd : null,
      totalLiquidityUsd: p0Usd !== null && p1Usd !== null ? amount0 * p0Usd + amount1 * p1Usd : null,
      hasFees: rawFees0 > 0n || rawFees1 > 0n,
    };
  });

  return { positions };
}

// ── V4 Positions ──────────────────────────────────────────────────────────────

export async function getV4Positions(walletAddress) {
  const key = process.env.ALCHEMY_API_KEY;
  if (!key) return { positions: [], noAlchemy: true };

  const address = getAddress(walletAddress);
  const client = createClient();

  const nftRes = await fetch(
    `https://base-mainnet.g.alchemy.com/nft/v3/${key}/getNFTsForOwner?owner=${address}&contractAddresses[]=${V4_PM_ADDRESS}&withMetadata=false`
  );
  if (!nftRes.ok) return { positions: [], error: 'Alchemy NFT API error' };
  const nftData = await nftRes.json();
  const ownedNfts = nftData.ownedNfts ?? [];
  if (ownedNfts.length === 0) return { positions: [] };

  const tokenIds = ownedNfts.map(n => BigInt(n.tokenId));
  const infoResults = await client.multicall({
    contracts: tokenIds.flatMap(tokenId => [
      { address: V4_PM_ADDRESS, abi: V4_PM_ABI, functionName: 'getPoolAndPositionInfo', args: [tokenId] },
      { address: V4_PM_ADDRESS, abi: V4_PM_ABI, functionName: 'getPositionLiquidity', args: [tokenId] },
    ]),
  });

  const positions = [];
  for (let i = 0; i < tokenIds.length; i++) {
    const poolR = infoResults[i * 2], liqR = infoResults[i * 2 + 1];
    if (poolR.status !== 'success' || liqR.status !== 'success') continue;
    const [poolKey, positionInfo] = poolR.result;
    const liquidity = liqR.result;
    const rawLower = Number((positionInfo >> 8n) & 0xffffffn);
    const tickLower = rawLower >= 0x800000 ? rawLower - 0x1000000 : rawLower;
    const rawUpper = Number((positionInfo >> 32n) & 0xffffffn);
    const tickUpper = rawUpper >= 0x800000 ? rawUpper - 0x1000000 : rawUpper;
    positions.push({ tokenId: tokenIds[i], poolKey, tickLower, tickUpper, liquidity });
  }
  if (positions.length === 0) return { positions: [] };

  const uniqueNonEth = [...new Set(
    positions.flatMap(p => [p.poolKey.currency0, p.poolKey.currency1])
      .filter(a => a.toLowerCase() !== NATIVE_ETH),
  )];
  const tokenMetaResults = await client.multicall({
    contracts: uniqueNonEth.flatMap(addr => [
      { address: addr, abi: ERC20_ABI, functionName: 'symbol' },
      { address: addr, abi: ERC20_ABI, functionName: 'decimals' },
    ]),
  });
  const tokenMeta = { [NATIVE_ETH]: { symbol: 'ETH', decimals: 18 } };
  uniqueNonEth.forEach((addr, i) => {
    tokenMeta[addr.toLowerCase()] = {
      symbol: tokenMetaResults[i * 2].status === 'success' ? tokenMetaResults[i * 2].result : '???',
      decimals: tokenMetaResults[i * 2 + 1].status === 'success' ? tokenMetaResults[i * 2 + 1].result : 18,
    };
  });

  const stateResults = await client.multicall({
    contracts: positions.flatMap(p => {
      const poolId = getPoolId(p.poolKey.currency0, p.poolKey.currency1, p.poolKey.fee, p.poolKey.tickSpacing, p.poolKey.hooks);
      const salt = ('0x' + p.tokenId.toString(16).padStart(64, '0'));
      return [
        { address: V4_STATE_VIEW, abi: STATE_VIEW_ABI, functionName: 'getSlot0', args: [poolId] },
        { address: V4_STATE_VIEW, abi: STATE_VIEW_ABI, functionName: 'getFeeGrowthGlobals', args: [poolId] },
        { address: V4_STATE_VIEW, abi: STATE_VIEW_ABI, functionName: 'getTickInfo', args: [poolId, p.tickLower] },
        { address: V4_STATE_VIEW, abi: STATE_VIEW_ABI, functionName: 'getTickInfo', args: [poolId, p.tickUpper] },
        { address: V4_STATE_VIEW, abi: STATE_VIEW_ABI, functionName: 'getPositionInfo', args: [poolId, V4_PM_ADDRESS, p.tickLower, p.tickUpper, salt] },
      ];
    }),
  });

  const allAddrs = [...new Set(positions.flatMap(p => [p.poolKey.currency0.toLowerCase(), p.poolKey.currency1.toLowerCase()]))];
  const usdPrices = await getDeFiLlamaPrices(allAddrs.map(a => a === NATIVE_ETH ? WETH_BASE : a));
  const wethPrice = usdPrices[WETH_BASE.toLowerCase()];
  if (wethPrice) usdPrices[NATIVE_ETH] = wethPrice;

  const result = positions.map((p, i) => {
    const b = i * 5;
    const slot0 = stateResults[b].status === 'success' ? stateResults[b].result : null;
    const sqrtPrice = slot0 ? slot0[0] : null;
    const currentTick = slot0 ? slot0[1] : null;
    const inRange = currentTick !== null ? currentTick >= p.tickLower && currentTick < p.tickUpper : null;
    const feeGrowths = stateResults[b+1].status === 'success' ? stateResults[b+1].result : null;
    const fgg0 = feeGrowths ? feeGrowths[0] : 0n;
    const fgg1 = feeGrowths ? feeGrowths[1] : 0n;
    const tld = stateResults[b+2].status === 'success' ? stateResults[b+2].result : null;
    const tud = stateResults[b+3].status === 'success' ? stateResults[b+3].result : null;
    const posInfo = stateResults[b+4].status === 'success' ? stateResults[b+4].result : null;
    const fg0Last = posInfo ? posInfo[1] : 0n;
    const fg1Last = posInfo ? posInfo[2] : 0n;

    const token0Addr = p.poolKey.currency0;
    const token1Addr = p.poolKey.currency1;
    const meta0 = tokenMeta[token0Addr.toLowerCase()] ?? { symbol: '???', decimals: 18 };
    const meta1 = tokenMeta[token1Addr.toLowerCase()] ?? { symbol: '???', decimals: 18 };

    const rawFees0 = currentTick !== null && p.liquidity > 0n
      ? calcAccruedFees(p.liquidity, fgg0, tld?.[2] ?? 0n, tud?.[2] ?? 0n, fg0Last, 0n, currentTick, p.tickLower, p.tickUpper) : 0n;
    const rawFees1 = currentTick !== null && p.liquidity > 0n
      ? calcAccruedFees(p.liquidity, fgg1, tld?.[3] ?? 0n, tud?.[3] ?? 0n, fg1Last, 0n, currentTick, p.tickLower, p.tickUpper) : 0n;

    const fees0 = formatUnits(rawFees0, meta0.decimals);
    const fees1 = formatUnits(rawFees1, meta1.decimals);
    const p0Usd = usdPrices[token0Addr.toLowerCase()] ?? null;
    const p1Usd = usdPrices[token1Addr.toLowerCase()] ?? null;
    const fees0Usd = p0Usd !== null ? parseFloat(fees0) * p0Usd : null;
    const fees1Usd = p1Usd !== null ? parseFloat(fees1) * p1Usd : null;
    const { amount0, amount1 } = sqrtPrice !== null && p.liquidity > 0n
      ? getTokenAmounts(sqrtPrice, p.tickLower, p.tickUpper, p.liquidity, meta0.decimals, meta1.decimals)
      : { amount0: 0, amount1: 0 };

    return {
      tokenId: p.tokenId.toString(),
      version: 'v4',
      token0: { address: token0Addr, symbol: meta0.symbol, decimals: meta0.decimals, priceUsd: p0Usd },
      token1: { address: token1Addr, symbol: meta1.symbol, decimals: meta1.decimals, priceUsd: p1Usd },
      fee: p.poolKey.fee, feeDisplay: formatFee(p.poolKey.fee),
      tickSpacing: p.poolKey.tickSpacing, hooks: p.poolKey.hooks,
      tickLower: p.tickLower, tickUpper: p.tickUpper,
      priceLower: tickToPrice(p.tickLower, meta0.decimals, meta1.decimals).toFixed(6),
      priceUpper: tickToPrice(p.tickUpper, meta0.decimals, meta1.decimals).toFixed(6),
      liquidity: p.liquidity.toString(), hasLiquidity: p.liquidity > 0n, inRange,
      fees0, fees1, fees0Usd, fees1Usd,
      totalFeesUsd: fees0Usd !== null && fees1Usd !== null ? fees0Usd + fees1Usd : null,
      amount0, amount1,
      amount0Usd: p0Usd !== null ? amount0 * p0Usd : null,
      amount1Usd: p1Usd !== null ? amount1 * p1Usd : null,
      totalLiquidityUsd: p0Usd !== null && p1Usd !== null ? amount0 * p0Usd + amount1 * p1Usd : null,
      hasFees: rawFees0 > 0n || rawFees1 > 0n,
    };
  });

  return { positions: result };
}

// ── P&L ───────────────────────────────────────────────────────────────────────

async function findMintViaAlchemy(alchemyUrl, contractAddress, toAddress, tokenId) {
  let pageKey;
  do {
    const body = {
      jsonrpc: '2.0', id: 1, method: 'alchemy_getAssetTransfers',
      params: [{
        fromAddress: NATIVE_ETH, toAddress, contractAddresses: [contractAddress],
        category: ['erc721'], withMetadata: true, order: 'asc', maxCount: '0x64',
        ...(pageKey ? { pageKey } : {}),
      }],
    };
    const res = await fetch(alchemyUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!res.ok) return null;
    const json = await res.json();
    const result = json?.result;
    if (!result?.transfers) return null;
    for (const tx of result.transfers) {
      if (!tx.erc721TokenId) continue;
      if (BigInt(tx.erc721TokenId) === tokenId) {
        return {
          hash: tx.hash,
          blockNumber: BigInt(tx.blockNum),
          timestamp: tx.metadata?.blockTimestamp ? Math.floor(new Date(tx.metadata.blockTimestamp).getTime() / 1000) : 0,
        };
      }
    }
    pageKey = result.pageKey;
  } while (pageKey);
  return null;
}

async function fetchV3Collected(client, alchemyUrl, walletAddress, token0, token1, fee, tokenId, decimals0, decimals1, fromBlock) {
  const fromBlockHex = '0x' + fromBlock.toString(16);
  const isEth0 = token0.toLowerCase() === NATIVE_ETH;
  const isEth1 = token1.toLowerCase() === NATIVE_ETH;
  const t0 = isEth0 ? WETH_BASE : token0;
  const t1 = isEth1 ? WETH_BASE : token1;
  let poolAddress;
  try {
    poolAddress = await client.readContract({ address: FACTORY_ADDRESS, abi: FACTORY_ABI, functionName: 'getPool', args: [t0, t1, fee] });
  } catch { poolAddress = NATIVE_ETH; }

  const collectERC20 = async (fromAddr, contractAddress, toAddr = walletAddress) => {
    const result = [];
    let pageKey;
    do {
      const body = {
        jsonrpc: '2.0', id: 1, method: 'alchemy_getAssetTransfers',
        params: [{
          fromAddress: fromAddr, toAddress: toAddr, contractAddresses: [contractAddress],
          category: ['erc20'], fromBlock: fromBlockHex, withMetadata: true, order: 'asc', maxCount: '0x3e8',
          ...(pageKey ? { pageKey } : {}),
        }],
      };
      const res = await fetch(alchemyUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (!res.ok) break;
      const json = await res.json();
      for (const tx of (json?.result?.transfers ?? [])) {
        if (tx.value != null) {
          result.push({
            amount: tx.value,
            timestamp: tx.metadata?.blockTimestamp ? Math.floor(new Date(tx.metadata.blockTimestamp).getTime() / 1000) : Math.floor(Date.now() / 1000),
            hash: tx.hash,
          });
        }
      }
      pageKey = json?.result?.pageKey;
    } while (pageKey);
    return result;
  };

  try {
    const [pool0, npm0, pool1, npm1] = await Promise.all([
      collectERC20(poolAddress, t0), collectERC20(NPM_ADDRESS, t0),
      collectERC20(poolAddress, t1), collectERC20(NPM_ADDRESS, t1),
    ]);
    let all0 = [...pool0, ...npm0];
    let all1 = [...pool1, ...npm1];

    const isWethLike0 = isEth0 || t0.toLowerCase() === WETH_BASE.toLowerCase();
    const isWethLike1 = isEth1 || t1.toLowerCase() === WETH_BASE.toLowerCase();
    if ((isWethLike0 && all0.length === 0) || (isWethLike1 && all1.length === 0)) {
      const walletTxTs = new Map();
      let pageKey;
      do {
        const body = {
          jsonrpc: '2.0', id: 1, method: 'alchemy_getAssetTransfers',
          params: [{
            fromAddress: walletAddress, category: ['external'], fromBlock: fromBlockHex,
            excludeZeroValue: false, withMetadata: true, order: 'asc', maxCount: '0x3e8',
            ...(pageKey ? { pageKey } : {}),
          }],
        };
        const res = await fetch(alchemyUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        if (!res.ok) break;
        const json = await res.json();
        for (const tx of (json?.result?.transfers ?? [])) {
          if (tx.hash) {
            walletTxTs.set(tx.hash, tx.metadata?.blockTimestamp ? Math.floor(new Date(tx.metadata.blockTimestamp).getTime() / 1000) : Math.floor(Date.now() / 1000));
          }
        }
        pageKey = json?.result?.pageKey;
      } while (pageKey);

      if (isWethLike0 && all0.length === 0) {
        all0 = (await collectERC20(poolAddress, t0, NPM_ADDRESS))
          .filter(tx => tx.hash && walletTxTs.has(tx.hash))
          .map(tx => ({ ...tx, timestamp: walletTxTs.get(tx.hash) ?? tx.timestamp }));
      }
      if (isWethLike1 && all1.length === 0) {
        all1 = (await collectERC20(poolAddress, t1, NPM_ADDRESS))
          .filter(tx => tx.hash && walletTxTs.has(tx.hash))
          .map(tx => ({ ...tx, timestamp: walletTxTs.get(tx.hash) ?? tx.timestamp }));
      }
    }

    const DEC_LIQ_TOPIC = '0x26f6a048ee9138f2c0ce266f322cb99228e8d619ae2bff30c67f8dcf9d2377b4';
    const paddedTokenId = '0x' + tokenId.toString(16).padStart(64, '0');
    const uniqueHashes = [...new Set([...all0, ...all1].map(tx => tx.hash).filter(Boolean))];
    const principalByHash = new Map();
    await Promise.all(uniqueHashes.map(async hash => {
      try {
        const receipt = await client.getTransactionReceipt({ hash });
        let p0 = 0n, p1 = 0n;
        for (const log of receipt.logs) {
          if (log.address.toLowerCase() === NPM_ADDRESS.toLowerCase() &&
              log.topics[0] === DEC_LIQ_TOPIC &&
              log.topics[1]?.toLowerCase() === paddedTokenId) {
            const d = log.data.slice(2);
            p0 = BigInt('0x' + d.slice(64, 128));
            p1 = BigInt('0x' + d.slice(128, 192));
            break;
          }
        }
        principalByHash.set(hash, { p0: parseFloat(formatUnits(p0, decimals0)), p1: parseFloat(formatUnits(p1, decimals1)) });
      } catch { principalByHash.set(hash, { p0: 0, p1: 0 }); }
    }));

    const roundHour = ts => Math.round(ts / 3600) * 3600;
    const priceMap = new Map();
    await Promise.all([...new Set([...all0, ...all1].map(tx => roundHour(tx.timestamp)))].map(async ts => {
      priceMap.set(ts, await getHistoricalPrices(ts, token0, token1));
    }));

    let amount0 = 0, amount1 = 0, usd0 = 0, usd1 = 0;
    let fees0 = 0, fees1 = 0, feesUsd0 = 0, feesUsd1 = 0;
    let principal0 = 0, principal1 = 0, principalUsd0 = 0, principalUsd1 = 0;
    let usd0Valid = true, usd1Valid = true;

    for (const tx of all0) {
      amount0 += tx.amount;
      const pe = tx.hash ? (principalByHash.get(tx.hash) ?? { p0: 0 }) : { p0: 0 };
      const txP = Math.min(tx.amount, pe.p0); const txF = Math.max(0, tx.amount - txP);
      principal0 += txP; fees0 += txF;
      const p = priceMap.get(roundHour(tx.timestamp))?.price0;
      if (p != null) { usd0 += tx.amount * p; feesUsd0 += txF * p; principalUsd0 += txP * p; } else usd0Valid = false;
    }
    for (const tx of all1) {
      amount1 += tx.amount;
      const pe = tx.hash ? (principalByHash.get(tx.hash) ?? { p1: 0 }) : { p1: 0 };
      const txP = Math.min(tx.amount, pe.p1 ?? 0); const txF = Math.max(0, tx.amount - txP);
      principal1 += txP; fees1 += txF;
      const p = priceMap.get(roundHour(tx.timestamp))?.price1;
      if (p != null) { usd1 += tx.amount * p; feesUsd1 += txF * p; principalUsd1 += txP * p; } else usd1Valid = false;
    }

    return {
      amount0, amount1,
      amount0Usd: all0.length > 0 ? (usd0Valid ? usd0 : null) : 0,
      amount1Usd: all1.length > 0 ? (usd1Valid ? usd1 : null) : 0,
      fees0, fees1,
      fees0Usd: usd0Valid ? feesUsd0 : null,
      fees1Usd: usd1Valid ? feesUsd1 : null,
      principal0, principal1,
      principal0Usd: usd0Valid ? principalUsd0 : null,
      principal1Usd: usd1Valid ? principalUsd1 : null,
      count: all0.length + all1.length,
    };
  } catch {
    return { amount0: 0, amount1: 0, amount0Usd: 0, amount1Usd: 0, fees0: 0, fees1: 0, fees0Usd: 0, fees1Usd: 0, principal0: 0, principal1: 0, principal0Usd: 0, principal1Usd: 0, count: 0 };
  }
}

export async function getPnl(params) {
  const { tokenId: tokenIdStr, version, token0Raw, token1Raw, walletRaw } = params;
  const decimals0 = parseInt(params.decimals0 ?? '18');
  const decimals1 = parseInt(params.decimals1 ?? '18');

  const key = process.env.ALCHEMY_API_KEY;
  if (!key) return { error: 'ALCHEMY_API_KEY not configured — add it to .env to enable P&L' };

  const tokenId = BigInt(tokenIdStr);
  const token0 = getAddress(token0Raw);
  const token1 = getAddress(token1Raw);
  const walletAddress = getAddress(walletRaw);
  const alchemyUrl = `https://base-mainnet.g.alchemy.com/v2/${key}`;
  const client = createClient();

  if (version === 'v3') {
    const fee = parseInt(params.fee ?? '0');
    const mint = await findMintViaAlchemy(alchemyUrl, NPM_ADDRESS, walletAddress, tokenId);
    if (!mint) return { error: 'Mint event not found for this wallet' };
    let mintTimestamp = mint.timestamp;
    if (mintTimestamp === 0) {
      const block = await client.getBlock({ blockNumber: mint.blockNumber });
      mintTimestamp = Number(block.timestamp);
    }

    const V3_INCREASE_LIQ = parseAbiItem('event IncreaseLiquidity(uint256 indexed tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)');
    let entryAmount0 = 0, entryAmount1 = 0;
    try {
      const receipt = await client.getTransactionReceipt({ hash: mint.hash });
      for (const log of receipt.logs) {
        try {
          const decoded = decodeEventLog({ abi: [V3_INCREASE_LIQ], data: log.data, topics: log.topics });
          if (decoded.eventName === 'IncreaseLiquidity' && decoded.args.tokenId === tokenId) {
            entryAmount0 = parseFloat(formatUnits(decoded.args.amount0, decimals0));
            entryAmount1 = parseFloat(formatUnits(decoded.args.amount1, decimals1));
            break;
          }
        } catch {}
      }
    } catch {}

    const [entryPrices, collected] = await Promise.all([
      getHistoricalPrices(mintTimestamp, token0, token1),
      fetchV3Collected(client, alchemyUrl, walletAddress, token0, token1, fee, tokenId, decimals0, decimals1, mint.blockNumber),
    ]);

    const entry0Usd = entryPrices.price0 !== null ? entryAmount0 * entryPrices.price0 : null;
    const entry1Usd = entryPrices.price1 !== null ? entryAmount1 * entryPrices.price1 : null;
    const totalCollectedUsd = collected.amount0Usd !== null || collected.amount1Usd !== null
      ? (collected.amount0Usd ?? 0) + (collected.amount1Usd ?? 0) : null;

    return {
      version: 'v3', mintTimestamp, entryAmount0, entryAmount1,
      entryPrice0: entryPrices.price0, entryPrice1: entryPrices.price1,
      entry0Usd, entry1Usd,
      entryTotalUsd: entry0Usd !== null && entry1Usd !== null ? entry0Usd + entry1Usd : null,
      collectedAmount0: collected.amount0, collectedAmount1: collected.amount1,
      collected0Usd: collected.amount0Usd, collected1Usd: collected.amount1Usd,
      fees0: collected.fees0, fees1: collected.fees1,
      fees0Usd: collected.fees0Usd, fees1Usd: collected.fees1Usd,
      principal0: collected.principal0, principal1: collected.principal1,
      principal0Usd: collected.principal0Usd, principal1Usd: collected.principal1Usd,
      totalCollectedUsd, collectionsCount: collected.count,
      v4CollectedUnavailable: false,
    };
  }

  if (version === 'v4') {
    const tickLower = parseInt(params.tickLower ?? '0');
    const tickUpper = parseInt(params.tickUpper ?? '0');
    const fee = parseInt(params.fee ?? '0');
    const tickSpacing = parseInt(params.tickSpacing ?? '0');
    const hooks = params.hooks ?? NATIVE_ETH;
    const liquidity = BigInt(params.liquidity ?? '0');

    const mint = await findMintViaAlchemy(alchemyUrl, V4_PM_ADDRESS, walletAddress, tokenId);
    if (!mint) return { error: 'Mint event not found for this wallet' };
    let mintTimestamp = mint.timestamp;
    if (mintTimestamp === 0) {
      const block = await client.getBlock({ blockNumber: mint.blockNumber });
      mintTimestamp = Number(block.timestamp);
    }

    let entryAmount0 = 0, entryAmount1 = 0;
    try {
      const poolId = getPoolId(token0, token1, fee, tickSpacing, hooks);
      const slot0 = await client.readContract({
        address: V4_STATE_VIEW, abi: STATE_VIEW_ABI, functionName: 'getSlot0',
        args: [poolId], blockNumber: mint.blockNumber,
      });
      if (slot0[0] > 0n && liquidity > 0n) {
        const amounts = getTokenAmounts(slot0[0], tickLower, tickUpper, liquidity, decimals0, decimals1);
        entryAmount0 = amounts.amount0;
        entryAmount1 = amounts.amount1;
      }
    } catch {}

    const entryPrices = await getHistoricalPrices(mintTimestamp, token0, token1);
    const entry0Usd = entryPrices.price0 !== null && entryAmount0 > 0 ? entryAmount0 * entryPrices.price0 : null;
    const entry1Usd = entryPrices.price1 !== null && entryAmount1 > 0 ? entryAmount1 * entryPrices.price1 : null;

    return {
      version: 'v4', mintTimestamp, entryAmount0, entryAmount1,
      entryPrice0: entryPrices.price0, entryPrice1: entryPrices.price1,
      entry0Usd, entry1Usd,
      entryTotalUsd: entry0Usd !== null && entry1Usd !== null ? entry0Usd + entry1Usd : null,
      collectedAmount0: 0, collectedAmount1: 0, totalCollectedUsd: 0, collectionsCount: 0,
      v4CollectedUnavailable: true,
    };
  }

  return { error: 'invalid version' };
}

// ── Collect Fees + Auto-Swap WETH→USDC ───────────────────────────────────────

const SWAP_ROUTER    = '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45';
const USDC_BASE      = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const WETH_USDC_FEE  = 500; // 0.05% canonical WETH/USDC pool on Base

const SWAP_ROUTER_ABI = [
  { name: 'exactInputSingle', type: 'function', stateMutability: 'payable',
    inputs: [{ name: 'params', type: 'tuple', components: [
      { name: 'tokenIn', type: 'address' },
      { name: 'tokenOut', type: 'address' },
      { name: 'fee', type: 'uint24' },
      { name: 'recipient', type: 'address' },
      { name: 'amountIn', type: 'uint256' },
      { name: 'amountOutMinimum', type: 'uint256' },
      { name: 'sqrtPriceLimitX96', type: 'uint160' },
    ]}],
    outputs: [{ name: 'amountOut', type: 'uint256' }] },
];

const ERC20_APPROVE_ABI = [
  { name: 'approve', type: 'function', stateMutability: 'nonpayable',
    inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }],
    outputs: [{ name: '', type: 'bool' }] },
  { name: 'allowance', type: 'function', stateMutability: 'view',
    inputs: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }] },
];

const COLLECT_EVENT = parseAbiItem(
  'event Collect(uint256 indexed tokenId, address recipient, uint256 amount0, uint256 amount1)'
);

export async function collectAndSwap(tokenId, recipientAddress, privateKey, token0, token1) {
  const account = privateKeyToAccount(privateKey);
  const rpc = getAlchemyUrl();
  const walletClient = createWalletClient({ account, chain: base, transport: http(rpc) });
  const client = createClient();
  const MAX_UINT128 = (2n ** 128n) - 1n;
  const recipient = getAddress(recipientAddress);
  const tid = BigInt(tokenId);

  // 1. Collect fees
  const collectHash = await walletClient.writeContract({
    address: NPM_ADDRESS,
    abi: COLLECT_ABI,
    functionName: 'collect',
    args: [{ tokenId: tid, recipient, amount0Max: MAX_UINT128, amount1Max: MAX_UINT128 }],
  });
  const collectReceipt = await client.waitForTransactionReceipt({ hash: collectHash });

  // 2. Parse Collect event to get exact amounts
  let rawAmount0 = 0n, rawAmount1 = 0n;
  for (const log of collectReceipt.logs) {
    try {
      const decoded = decodeEventLog({ abi: [COLLECT_EVENT], data: log.data, topics: log.topics });
      if (decoded.eventName === 'Collect' && decoded.args.tokenId === tid) {
        rawAmount0 = decoded.args.amount0;
        rawAmount1 = decoded.args.amount1;
        break;
      }
    } catch {}
  }

  const dec0 = token0?.decimals ?? 18;
  const dec1 = token1?.decimals ?? 6;
  const sym0 = token0?.symbol ?? 'TOKEN0';
  const sym1 = token1?.symbol ?? 'TOKEN1';
  const addr0 = token0?.address?.toLowerCase() ?? '';
  const addr1 = token1?.address?.toLowerCase() ?? '';

  const collected0 = parseFloat(formatUnits(rawAmount0, dec0));
  const collected1 = parseFloat(formatUnits(rawAmount1, dec1));

  // 3. Identify WETH token and swap it to USDC if collected
  const isWeth0 = addr0 === WETH_BASE.toLowerCase();
  const isWeth1 = addr1 === WETH_BASE.toLowerCase();
  const wethAmount = isWeth0 ? rawAmount0 : isWeth1 ? rawAmount1 : 0n;
  const wethDecimals = isWeth0 ? dec0 : dec1;

  let swapHash = null;
  let usdcFromSwap = 0;

  if (wethAmount > 0n) {
    // Approve WETH to SwapRouter if needed
    const allowance = await client.readContract({
      address: WETH_BASE,
      abi: ERC20_APPROVE_ABI,
      functionName: 'allowance',
      args: [recipient, SWAP_ROUTER],
    });
    if (allowance < wethAmount) {
      const approveHash = await walletClient.writeContract({
        address: WETH_BASE,
        abi: ERC20_APPROVE_ABI,
        functionName: 'approve',
        args: [SWAP_ROUTER, wethAmount],
      });
      await client.waitForTransactionReceipt({ hash: approveHash });
    }

    // Swap WETH → USDC (amountOutMinimum=0 is safe for small fee amounts on deep pool)
    swapHash = await walletClient.writeContract({
      address: SWAP_ROUTER,
      abi: SWAP_ROUTER_ABI,
      functionName: 'exactInputSingle',
      args: [{
        tokenIn: WETH_BASE,
        tokenOut: USDC_BASE,
        fee: WETH_USDC_FEE,
        recipient,
        amountIn: wethAmount,
        amountOutMinimum: 0n,
        sqrtPriceLimitX96: 0n,
      }],
    });
    const swapReceipt = await client.waitForTransactionReceipt({ hash: swapHash });

    // Read USDC received from Transfer event (simpler than parsing swap return)
    const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
    const usdcAddrLower = USDC_BASE.toLowerCase();
    for (const log of swapReceipt.logs) {
      if (
        log.address.toLowerCase() === usdcAddrLower &&
        log.topics[0] === TRANSFER_TOPIC &&
        log.topics[2]?.toLowerCase().endsWith(recipient.toLowerCase().slice(2).padStart(64, '0').slice(-40))
      ) {
        usdcFromSwap = parseFloat(formatUnits(BigInt(log.data), 6));
        break;
      }
    }
  }

  // 4. Tally total USDC equivalent
  const isUsdc1 = addr1 === USDC_BASE.toLowerCase();
  const isUsdc0 = addr0 === USDC_BASE.toLowerCase();
  const directUsdc = isUsdc1 ? collected1 : isUsdc0 ? collected0 : 0;
  const usdcTotal = directUsdc + usdcFromSwap;

  return {
    collectHash,
    swapHash,
    collected0,
    collected1,
    sym0, sym1,
    wethSwapped: parseFloat(formatUnits(wethAmount, wethDecimals)),
    usdcFromSwap,
    directUsdc,
    usdcTotal,
    pool: `${sym0}/${sym1}`,
  };
}
