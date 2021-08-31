const { Pool } = require('pg');
const Cache = require('node-cache');

const BRIDGE_TOKEN_FACTORY_ACCOUNT_ID = process.env.BRIDGE_TOKEN_FACTORY_ACCOUNT_ID || 'factory.bridge.near';
const WALLET_URL = process.env.WALLET_URL;

// TODO: Replace with `NETWORK_ID` environment var check when we have one
const IS_MAINNET = WALLET_URL.includes('wallet.near.org');

const pool = new Pool({ connectionString: process.env.INDEXER_DB_CONNECTION, });

const findStakingDeposits = async (ctx) => {
    const { accountId } = ctx.params;

    let poolMatch;

    if (IS_MAINNET) {
        poolMatch = '%.poolv1.near';
    } else {
        poolMatch = '%.pool.%.m0';
    }

    const { rows } = await pool.query(`
        with deposit_in as (
            select SUM(to_number(args ->> 'deposit', '99999999999999999999999999999999999999')) deposit,
                receipt_receiver_account_id validator_id
            from action_receipt_actions
            where
                action_kind = 'FUNCTION_CALL' and
                args ->> 'method_name' like 'deposit%' and
                receipt_predecessor_account_id = $1 and
                receipt_receiver_account_id like '${poolMatch}'
            group by receipt_receiver_account_id
        ), deposit_out as (
            select SUM(to_number(args ->> 'deposit', '99999999999999999999999999999999999999')) deposit,
                receipt_predecessor_account_id validator_id
            from action_receipt_actions
            where
                action_kind = 'TRANSFER' and
                receipt_receiver_account_id = $1 and
                receipt_predecessor_account_id like '${poolMatch}'
            group by receipt_predecessor_account_id
        )
        select sum(deposit_in.deposit - coalesce(deposit_out.deposit, 0)) deposit, deposit_in.validator_id
        from deposit_in
        left join deposit_out on deposit_in.validator_id = deposit_out.validator_id
        group by deposit_in.validator_id;
    `, [accountId]);

    ctx.body = rows;
};

const findAccountActivity = async (ctx) => {
    const { accountId } = ctx.params;
    let { offset, limit = 10 } = ctx.request.query;
    if (!offset) {
        offset = '9999999999999999999';
    }
    const { rows } = await pool.query(`
        select
            included_in_block_hash block_hash,
            included_in_block_timestamp block_timestamp,
            originated_from_transaction_hash hash,
            index_in_action_receipt action_index,
            predecessor_account_id signer_id,
            receiver_account_id receiver_id,
            action_kind,
            args
        from action_receipt_actions
        join receipts using(receipt_id)
        where
            receipt_predecessor_account_id != 'system' and
            (receipt_predecessor_account_id = $1 or receipt_receiver_account_id = $1) and
            $2 > receipt_included_in_block_timestamp
        order by receipt_included_in_block_timestamp desc
        limit $3
        ;
    `, [accountId, offset, limit]);

    ctx.body = rows;
};

const findAccountsByPublicKey = async (ctx) => {
    const { publicKey } = ctx.params;
    const { rows } = await pool.query(`
        SELECT DISTINCT account_id
        FROM access_keys
        JOIN accounts USING (account_id)
        WHERE public_key = $1
            AND accounts.deleted_by_receipt_id IS NULL
            AND access_keys.deleted_by_receipt_id IS NULL
    `, [publicKey]);
    ctx.body = rows.map(({ account_id }) => account_id);
};

const findReceivers = async (ctx) => {
    const { accountId } = ctx.params;

    const { rows } = await pool.query(`
        select distinct receipt_receiver_account_id as receiver_account_id
        from action_receipt_actions
        where receipt_predecessor_account_id = $1
            and action_kind = 'FUNCTION_CALL'
    `, [accountId]);
    ctx.body = rows.map(({ receiver_account_id }) => receiver_account_id);
};

const findLikelyTokens = async (ctx) => {
    const { accountId } = ctx.params;

    const received = `
        select distinct receipt_receiver_account_id as receiver_account_id
        from action_receipt_actions
        where args->'args_json'->>'receiver_id' = $1
            and action_kind = 'FUNCTION_CALL'
            and args->>'args_json' is not null
            and args->>'method_name' in ('ft_transfer', 'ft_transfer_call','ft_mint')
    `;

    const mintedWithBridge = `
        select distinct receipt_receiver_account_id as receiver_account_id from (
            select args->'args_json'->>'account_id' as account_id, receipt_receiver_account_id
            from action_receipt_actions
            where action_kind = 'FUNCTION_CALL' and
                receipt_predecessor_account_id = $2 and
                args->>'method_name' = 'mint'
        ) minted_with_bridge
        where account_id = $1
    `;

    const calledByUser = `
        select distinct receipt_receiver_account_id as receiver_account_id
        from action_receipt_actions
        where receipt_predecessor_account_id = $1
            and action_kind = 'FUNCTION_CALL'
            and (args->>'method_name' like 'ft_%' or args->>'method_name' = 'storage_deposit')
    `;

    const { rows } = await pool.query([received, mintedWithBridge, calledByUser].join(' union '), [accountId, BRIDGE_TOKEN_FACTORY_ACCOUNT_ID]);
    ctx.body = rows.map(({ receiver_account_id }) => receiver_account_id);
};


const findLikelyNFTs = async (ctx) => {
    const { accountId } = ctx.params;

    const received = `
        select distinct receipt_receiver_account_id as receiver_account_id
        from action_receipt_actions
        where args->'args_json'->>'receiver_id' = $1
            and action_kind = 'FUNCTION_CALL'
            and args->>'args_json' is not null
            and args->>'method_name' like 'nft_%'
    `;

    // TODO: How to query minted tokens?

    const { rows } = await pool.query([received].join(' union '), [accountId]);
    ctx.body = rows.map(({ receiver_account_id }) => receiver_account_id);
};


// One hour cache window since validators do not change often
const validatorCache = new Cache({ stdTTL: (60 * 1000) * 60, checkperiod: 0, clone: false });

async function fetchAndCacheValidators(cache) {
    let validatorDetails;

    if (IS_MAINNET) {
        ({ rows: validatorDetails } = await pool.query('SELECT account_id FROM accounts WHERE account_id LIKE \'%.poolv1.near\''));
    } else {
        ({ rows: validatorDetails } = await pool.query('SELECT account_id FROM accounts WHERE account_id LIKE \'%.pool.%.m0\''));
    }

    const validators = validatorDetails.map((v) => v.account_id);
    cache.set('validators', validators);

    return validators;
}

async function findStakingPools(ctx) {
    ctx.body = validatorCache.get('validators') || await fetchAndCacheValidators(validatorCache);
}

module.exports = {
    findStakingDeposits,
    findAccountActivity,
    findAccountsByPublicKey,
    findReceivers,
    findLikelyTokens,
    findLikelyNFTs,
    findStakingPools
};
