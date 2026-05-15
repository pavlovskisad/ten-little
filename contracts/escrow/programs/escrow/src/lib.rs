// Ten-little escrow program (devnet).
//
// Three roles, three flows:
//
//   admin    — bootstraps the singleton ProgramConfig + RakeVault PDAs;
//              flips the buyback SPL mint and NFT collection address
//              (placeholders on devnet, real values on mainnet promotion).
//
//   oracle   — the game server's keypair. Creates a Pot per quickmatch
//              room, marks the pot Playing when the round starts, and
//              calls finalize_pot to pay winners + retain rake when the
//              round ends. Practice rooms skip this entire flow.
//
//   players  — Privy-wallet users. Pay entry_fee SOL into the pot via
//              join_pot before the round starts; receive payouts from
//              finalize_pot if they place.
//
// Rake is collected into a single program-owned RakeVault PDA. Phase C
// adds the drain instruction that splits accumulated rake to a buyback
// PDA and the NFT rev-share PDA. For now rake just accumulates.

use anchor_lang::prelude::*;
use anchor_lang::system_program::{transfer, Transfer};

declare_id!("DsFoEFQw6uPGgXDztmuPUozi1AqP9KWC6N71H2MLVG5z");

const MAX_PLAYERS: usize = 10;
const RAKE_BPS_DEFAULT: u16 = 500; // 5%
const BUYBACK_BPS: u64 = 2000;     // 20% of every rake drain

#[program]
pub mod escrow {
    use super::*;

    /// One-time setup. Creates the singleton ProgramConfig and RakeVault
    /// PDAs. The admin (caller) becomes the only key allowed to flip
    /// settings or rotate the oracle. Rake basis-points default to 500
    /// (5%); admin can change later via `set_rake_bps`.
    pub fn init_config(ctx: Context<InitConfig>, oracle: Pubkey) -> Result<()> {
        let config = &mut ctx.accounts.config;
        config.admin = ctx.accounts.admin.key();
        config.oracle = oracle;
        config.rake_bps = RAKE_BPS_DEFAULT;
        config.buyback_mint = Pubkey::default();
        config.nft_collection = Pubkey::default();
        config.bump = ctx.bumps.config;

        ctx.accounts.rake_vault.bump = ctx.bumps.rake_vault;
        Ok(())
    }

    /// Admin sets the SPL token used for the buyback-and-burn rake
    /// destination. Default Pubkey::default() means "not configured" —
    /// Phase C will guard the buyback drain on this.
    pub fn set_buyback_token(ctx: Context<AdminUpdate>, mint: Pubkey) -> Result<()> {
        ctx.accounts.config.buyback_mint = mint;
        Ok(())
    }

    /// Admin sets the NFT collection mint that's eligible for rev-share.
    pub fn set_nft_collection(ctx: Context<AdminUpdate>, collection: Pubkey) -> Result<()> {
        ctx.accounts.config.nft_collection = collection;
        Ok(())
    }

    /// Admin can rotate the oracle (e.g., when the server's keypair
    /// is replaced).
    pub fn set_oracle(ctx: Context<AdminUpdate>, new_oracle: Pubkey) -> Result<()> {
        ctx.accounts.config.oracle = new_oracle;
        Ok(())
    }

    /// Admin can change rake (bounded so it can never exceed 100%).
    pub fn set_rake_bps(ctx: Context<AdminUpdate>, rake_bps: u16) -> Result<()> {
        require!(rake_bps <= 10_000, EscrowError::InvalidRake);
        ctx.accounts.config.rake_bps = rake_bps;
        Ok(())
    }

    /// Oracle creates a fresh Pot for a quickmatch room. The pot is
    /// keyed by room_id (the server's room code, packed as u64 — short
    /// codes left-pad with zeros). Pot starts in Waiting state and
    /// accepts joins until the oracle calls start_pot.
    pub fn init_pot(ctx: Context<InitPot>, room_id: u64, entry_fee: u64) -> Result<()> {
        require!(entry_fee > 0, EscrowError::InvalidEntryFee);
        let pot = &mut ctx.accounts.pot;
        pot.room_id = room_id;
        pot.entry_fee = entry_fee;
        pot.state = PotState::Waiting as u8;
        pot.players = vec![];
        pot.created_at = Clock::get()?.unix_timestamp;
        pot.bump = ctx.bumps.pot;
        Ok(())
    }

    /// Player pays entry_fee into the pot and is recorded in the
    /// player list. Idempotency: the same key can't join twice. Pot
    /// must be in Waiting state and not already at MAX_PLAYERS.
    pub fn join_pot(ctx: Context<JoinPot>) -> Result<()> {
        let pot = &mut ctx.accounts.pot;
        require!(pot.state == PotState::Waiting as u8, EscrowError::PotNotOpen);
        require!(pot.players.len() < MAX_PLAYERS, EscrowError::PotFull);
        require!(
            !pot.players.contains(&ctx.accounts.player.key()),
            EscrowError::AlreadyJoined
        );

        let cpi = CpiContext::new(
            ctx.accounts.system_program.key(),
            Transfer {
                from: ctx.accounts.player.to_account_info(),
                to: pot.to_account_info(),
            },
        );
        transfer(cpi, pot.entry_fee)?;

        pot.players.push(ctx.accounts.player.key());
        Ok(())
    }

    /// Oracle marks the pot as in-progress. Joins are rejected after
    /// this. Called when the lobby countdown ends or skip-timer fires.
    pub fn start_pot(ctx: Context<StartPot>, _room_id: u64) -> Result<()> {
        let pot = &mut ctx.accounts.pot;
        require!(pot.state == PotState::Waiting as u8, EscrowError::WrongState);
        pot.state = PotState::Playing as u8;
        Ok(())
    }

    /// Oracle refunds every paid player and closes the pot. Only valid
    /// while the pot is still Waiting — once start_pot fires, the round
    /// has begun and the next legal transition is finalize_pot. Used
    /// by the server when a paid quickmatch lobby gets cancelled
    /// before the round starts (e.g., a paid player leaves and we
    /// can't run a paid round with the remaining roster).
    ///
    /// Each player's wallet must be supplied as remaining_accounts[i],
    /// matching pot.players[i] one-for-one. The instruction pays each
    /// of them pot.entry_fee lamports; the pot's remaining lamports
    /// (rent-exempt minimum) refund to the oracle via close=oracle.
    pub fn refund_pot(ctx: Context<RefundPot>, _room_id: u64) -> Result<()> {
        let pot = &mut ctx.accounts.pot;
        require!(pot.state == PotState::Waiting as u8, EscrowError::WrongState);
        require!(
            ctx.remaining_accounts.len() == pot.players.len(),
            EscrowError::PayoutMismatch
        );

        for (i, expected) in pot.players.iter().enumerate() {
            let acc = &ctx.remaining_accounts[i];
            require!(acc.key() == *expected, EscrowError::WinnerMismatch);

            **pot.to_account_info().try_borrow_mut_lamports()? = pot
                .to_account_info()
                .lamports()
                .checked_sub(pot.entry_fee)
                .ok_or(EscrowError::Overflow)?;
            **acc.try_borrow_mut_lamports()? = acc
                .lamports()
                .checked_add(pot.entry_fee)
                .ok_or(EscrowError::Overflow)?;
        }

        pot.state = PotState::Finalized as u8;
        // close = oracle on the context refunds the remaining rent.
        Ok(())
    }

    /// Oracle distributes the pot. winners[i] receives amounts[i]
    /// lamports; rake (computed from rake_bps) goes to the rake_vault
    /// PDA; remaining rent on the closed pot account refunds to the
    /// oracle.
    ///
    /// Each winner's account must be supplied as a remaining_account,
    /// in the same order as the winners list. Validation:
    ///   - sum(amounts) + rake == sum_of_paid_entries
    ///   - every winner is in pot.players
    ///   - winners list has no duplicates
    pub fn finalize_pot(
        ctx: Context<FinalizePot>,
        _room_id: u64,
        winners: Vec<Pubkey>,
        amounts: Vec<u64>,
    ) -> Result<()> {
        let pot = &mut ctx.accounts.pot;
        require!(pot.state == PotState::Playing as u8, EscrowError::WrongState);
        require!(winners.len() == amounts.len(), EscrowError::PayoutMismatch);
        require!(
            ctx.remaining_accounts.len() == winners.len(),
            EscrowError::PayoutMismatch
        );

        // Pot value = number of players who paid * entry_fee. Joins
        // happen one at a time so this is exact.
        let total_played: u64 = (pot.players.len() as u64)
            .checked_mul(pot.entry_fee)
            .ok_or(EscrowError::Overflow)?;

        let rake: u64 = total_played
            .checked_mul(ctx.accounts.config.rake_bps as u64)
            .ok_or(EscrowError::Overflow)?
            / 10_000;

        let payout_total: u64 = amounts.iter().try_fold(0u64, |acc, &a| {
            acc.checked_add(a).ok_or(EscrowError::Overflow)
        })?;

        require!(
            payout_total
                .checked_add(rake)
                .ok_or(EscrowError::Overflow)?
                == total_played,
            EscrowError::PayoutMismatch
        );

        // Validate winners (in player list, no duplicates) and pay them
        // by lamport-manipulation. `pot` is a program-owned PDA, so
        // direct lamports decrement is allowed.
        let mut seen: Vec<Pubkey> = Vec::with_capacity(winners.len());
        for (i, winner_key) in winners.iter().enumerate() {
            require!(!seen.contains(winner_key), EscrowError::DuplicateWinner);
            require!(
                pot.players.contains(winner_key),
                EscrowError::NonPlayerWinner
            );
            seen.push(*winner_key);

            let winner_acc = &ctx.remaining_accounts[i];
            require!(
                winner_acc.key() == *winner_key,
                EscrowError::WinnerMismatch
            );

            **pot.to_account_info().try_borrow_mut_lamports()? = pot
                .to_account_info()
                .lamports()
                .checked_sub(amounts[i])
                .ok_or(EscrowError::Overflow)?;
            **winner_acc.try_borrow_mut_lamports()? = winner_acc
                .lamports()
                .checked_add(amounts[i])
                .ok_or(EscrowError::Overflow)?;
        }

        // Send rake into the rake vault.
        **pot.to_account_info().try_borrow_mut_lamports()? = pot
            .to_account_info()
            .lamports()
            .checked_sub(rake)
            .ok_or(EscrowError::Overflow)?;
        **ctx.accounts.rake_vault.to_account_info().try_borrow_mut_lamports()? = ctx
            .accounts
            .rake_vault
            .to_account_info()
            .lamports()
            .checked_add(rake)
            .ok_or(EscrowError::Overflow)?;

        pot.state = PotState::Finalized as u8;
        // `close = oracle` on the FinalizePot context returns whatever
        // lamports remain on the pot (rent-exempt minimum) to the oracle.
        Ok(())
    }

    // --------------------------------------------------------------
    // Phase C: rake distribution
    // --------------------------------------------------------------

    /// One-time setup for rake distribution. Creates the singleton
    /// RevShareState (with the configured NFT collection's supply)
    /// and BuybackVault PDAs. Admin specifies the buyback receiver
    /// wallet at init time; can be updated later via
    /// set_buyback_receiver.
    pub fn init_rev_share(
        ctx: Context<InitRevShare>,
        nft_supply: u64,
        buyback_receiver: Pubkey,
    ) -> Result<()> {
        require!(nft_supply > 0, EscrowError::InvalidNftSupply);
        let rs = &mut ctx.accounts.rev_share;
        rs.total_accrued_per_unit = 0;
        rs.nft_supply = nft_supply;
        rs.bump = ctx.bumps.rev_share;

        let bv = &mut ctx.accounts.buyback_vault;
        bv.receiver = buyback_receiver;
        bv.bump = ctx.bumps.buyback_vault;
        Ok(())
    }

    /// Admin can adjust the NFT supply count (e.g., if the collection
    /// expands or contracts before public claims open).
    pub fn set_nft_supply(ctx: Context<AdminUpdateRevShare>, new_supply: u64) -> Result<()> {
        require!(new_supply > 0, EscrowError::InvalidNftSupply);
        ctx.accounts.rev_share.nft_supply = new_supply;
        Ok(())
    }

    /// Admin can rotate the buyback receiver wallet without
    /// touching anything else.
    pub fn set_buyback_receiver(
        ctx: Context<AdminUpdateBuyback>,
        new_receiver: Pubkey,
    ) -> Result<()> {
        ctx.accounts.buyback_vault.receiver = new_receiver;
        Ok(())
    }

    /// Oracle drains the rake_vault: 20% lands in buyback_vault, 80%
    /// stays as SOL in the rev_share account AND bumps the accumulator
    /// so NFT holders can later claim their share. The split is fixed
    /// at the program level (2000/8000 bps); Phase D could make it
    /// admin-configurable.
    pub fn drain_rake_vault(ctx: Context<DrainRakeVault>) -> Result<()> {
        let rake_info = ctx.accounts.rake_vault.to_account_info();
        let rent = Rent::get()?.minimum_balance(rake_info.data_len());
        let drainable = rake_info.lamports().saturating_sub(rent);
        require!(drainable > 0, EscrowError::NothingToDrain);

        // 20% to buyback, 80% to rev-share. Integer math; the
        // remainder (after rounding) lands on rev-share which is
        // where most of the distribution goes anyway.
        let buyback_amount = drainable
            .checked_mul(BUYBACK_BPS)
            .ok_or(EscrowError::Overflow)?
            / 10_000;
        let rev_share_amount = drainable
            .checked_sub(buyback_amount)
            .ok_or(EscrowError::Overflow)?;

        // Move buyback share.
        **rake_info.try_borrow_mut_lamports()? = rake_info
            .lamports()
            .checked_sub(buyback_amount)
            .ok_or(EscrowError::Overflow)?;
        let bv_info = ctx.accounts.buyback_vault.to_account_info();
        **bv_info.try_borrow_mut_lamports()? = bv_info
            .lamports()
            .checked_add(buyback_amount)
            .ok_or(EscrowError::Overflow)?;

        // Move rev-share SOL onto the rev_share account itself; the
        // account holds the lamports until claim_rev_share pays them
        // out per NFT.
        let rs_info = ctx.accounts.rev_share.to_account_info();
        **rake_info.try_borrow_mut_lamports()? = rake_info
            .lamports()
            .checked_sub(rev_share_amount)
            .ok_or(EscrowError::Overflow)?;
        **rs_info.try_borrow_mut_lamports()? = rs_info
            .lamports()
            .checked_add(rev_share_amount)
            .ok_or(EscrowError::Overflow)?;

        // Accumulator: per-NFT delta added with PRECISION scaling
        // so small drains against a large supply don't round to 0.
        let rs = &mut ctx.accounts.rev_share;
        let added = (rev_share_amount as u128)
            .checked_mul(RevShareState::PRECISION)
            .ok_or(EscrowError::Overflow)?
            .checked_div(rs.nft_supply as u128)
            .ok_or(EscrowError::Overflow)?;
        rs.total_accrued_per_unit = rs
            .total_accrued_per_unit
            .checked_add(added)
            .ok_or(EscrowError::Overflow)?;
        Ok(())
    }

    /// Admin moves SOL out of the buyback_vault to the configured
    /// receiver wallet. The receiver is the off-chain pipeline that
    /// swaps SOL → buyback SPL token and burns it. This is the only
    /// instruction that exits SOL from buyback_vault.
    pub fn execute_buyback(ctx: Context<ExecuteBuyback>) -> Result<()> {
        let bv_info = ctx.accounts.buyback_vault.to_account_info();
        let rent = Rent::get()?.minimum_balance(bv_info.data_len());
        let amount = bv_info.lamports().saturating_sub(rent);
        require!(amount > 0, EscrowError::NothingToDrain);
        require!(
            ctx.accounts.receiver.key() == ctx.accounts.buyback_vault.receiver,
            EscrowError::BuybackReceiverMismatch
        );

        **bv_info.try_borrow_mut_lamports()? = bv_info
            .lamports()
            .checked_sub(amount)
            .ok_or(EscrowError::Overflow)?;
        **ctx.accounts.receiver.try_borrow_mut_lamports()? = ctx
            .accounts
            .receiver
            .lamports()
            .checked_add(amount)
            .ok_or(EscrowError::Overflow)?;
        Ok(())
    }
}

// ------------------------------------------------------------------
// Accounts
// ------------------------------------------------------------------

#[account]
pub struct ProgramConfig {
    pub admin: Pubkey,
    pub oracle: Pubkey,
    pub rake_bps: u16,
    pub buyback_mint: Pubkey,
    pub nft_collection: Pubkey,
    pub bump: u8,
}
impl ProgramConfig {
    // 8 disc + 32 admin + 32 oracle + 2 rake + 32 mint + 32 collection + 1 bump
    pub const SPACE: usize = 8 + 32 + 32 + 2 + 32 + 32 + 1;
}

#[account]
pub struct Pot {
    pub room_id: u64,
    pub entry_fee: u64,
    pub state: u8,
    pub players: Vec<Pubkey>,
    pub created_at: i64,
    pub bump: u8,
}
impl Pot {
    // 8 disc + 8 room + 8 fee + 1 state + (4 vec_len + 32 * MAX_PLAYERS) + 8 created + 1 bump
    pub const SPACE: usize = 8 + 8 + 8 + 1 + 4 + 32 * MAX_PLAYERS + 8 + 1;
}

#[account]
pub struct RakeVault {
    pub bump: u8,
}
impl RakeVault {
    pub const SPACE: usize = 8 + 1;
}

/// Synthetix-style accumulator for NFT-holder revenue share. Every
/// drain_rake_vault adds (rev_share_amount * PRECISION / nft_supply)
/// to `total_accrued_per_unit`. Each NFT-holder's claim equals
/// (total_accrued_per_unit - their last_claimed_per_unit) / PRECISION.
/// The PRECISION scaler (1e12) keeps division loss < 1 lamport per NFT
/// per drain even for small drains against a 10k-supply collection.
#[account]
pub struct RevShareState {
    pub total_accrued_per_unit: u128,
    pub nft_supply: u64,
    pub bump: u8,
}
impl RevShareState {
    // 8 disc + 16 u128 + 8 u64 + 1 bump
    pub const SPACE: usize = 8 + 16 + 8 + 1;
    pub const PRECISION: u128 = 1_000_000_000_000;
}

/// Buyback SOL bag. Holds 20% of every rake drain. `receiver` is the
/// wallet that's authorized to pull funds out (admin sets it via
/// set_buyback_receiver). The off-chain pipeline behind that wallet
/// swaps SOL for the configured buyback SPL token and burns it.
#[account]
pub struct BuybackVault {
    pub receiver: Pubkey,
    pub bump: u8,
}
impl BuybackVault {
    // 8 disc + 32 pubkey + 1 bump
    pub const SPACE: usize = 8 + 32 + 1;
}

/// Per-NFT claim cursor. Records the holder's last seen
/// total_accrued_per_unit so future claims pay only the delta. PDA
/// keyed on the NFT mint so the program enforces uniqueness without
/// trusting the caller's account.
#[account]
pub struct ClaimState {
    pub last_claimed_per_unit: u128,
    pub bump: u8,
}
impl ClaimState {
    pub const SPACE: usize = 8 + 16 + 1;
}

#[repr(u8)]
pub enum PotState {
    Waiting = 0,
    Playing = 1,
    Finalized = 2,
}

// ------------------------------------------------------------------
// Errors
// ------------------------------------------------------------------

#[error_code]
pub enum EscrowError {
    #[msg("pot is not open for joining")]
    PotNotOpen,
    #[msg("pot already has the maximum players")]
    PotFull,
    #[msg("player has already joined this pot")]
    AlreadyJoined,
    #[msg("pot is in the wrong state for this operation")]
    WrongState,
    #[msg("payout list and amounts inconsistent (or sum != pot - rake)")]
    PayoutMismatch,
    #[msg("winner pubkey doesn't match the corresponding remaining_account")]
    WinnerMismatch,
    #[msg("winner is not in the pot's player list")]
    NonPlayerWinner,
    #[msg("winners list contains a duplicate")]
    DuplicateWinner,
    #[msg("only the configured oracle may call this instruction")]
    OracleOnly,
    #[msg("only the admin may call this instruction")]
    AdminOnly,
    #[msg("entry fee must be greater than zero")]
    InvalidEntryFee,
    #[msg("rake basis-points must be at most 10000")]
    InvalidRake,
    #[msg("arithmetic overflow")]
    Overflow,
    #[msg("nft_supply must be greater than zero")]
    InvalidNftSupply,
    #[msg("nothing left to drain in this vault")]
    NothingToDrain,
    #[msg("provided receiver doesn't match the configured buyback receiver")]
    BuybackReceiverMismatch,
    #[msg("rev_share or buyback vault is not initialized")]
    RevShareNotInitialized,
    #[msg("nft does not belong to the configured collection")]
    NotInCollection,
    #[msg("caller does not hold the NFT being claimed")]
    NotNftHolder,
}

// ------------------------------------------------------------------
// Instruction contexts
// ------------------------------------------------------------------

#[derive(Accounts)]
pub struct InitConfig<'info> {
    #[account(
        init,
        payer = admin,
        seeds = [b"config"],
        bump,
        space = ProgramConfig::SPACE,
    )]
    pub config: Account<'info, ProgramConfig>,

    #[account(
        init,
        payer = admin,
        seeds = [b"rake_vault"],
        bump,
        space = RakeVault::SPACE,
    )]
    pub rake_vault: Account<'info, RakeVault>,

    #[account(mut)]
    pub admin: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AdminUpdate<'info> {
    #[account(
        mut,
        seeds = [b"config"],
        bump = config.bump,
        has_one = admin @ EscrowError::AdminOnly,
    )]
    pub config: Account<'info, ProgramConfig>,
    pub admin: Signer<'info>,
}

#[derive(Accounts)]
#[instruction(room_id: u64)]
pub struct InitPot<'info> {
    #[account(
        seeds = [b"config"],
        bump = config.bump,
        has_one = oracle @ EscrowError::OracleOnly,
    )]
    pub config: Account<'info, ProgramConfig>,

    #[account(
        init,
        payer = oracle,
        seeds = [b"pot", room_id.to_le_bytes().as_ref()],
        bump,
        space = Pot::SPACE,
    )]
    pub pot: Account<'info, Pot>,

    #[account(mut)]
    pub oracle: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct JoinPot<'info> {
    #[account(
        mut,
        seeds = [b"pot", pot.room_id.to_le_bytes().as_ref()],
        bump = pot.bump,
    )]
    pub pot: Account<'info, Pot>,

    #[account(mut)]
    pub player: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(room_id: u64)]
pub struct StartPot<'info> {
    #[account(
        seeds = [b"config"],
        bump = config.bump,
        has_one = oracle @ EscrowError::OracleOnly,
    )]
    pub config: Account<'info, ProgramConfig>,

    #[account(
        mut,
        seeds = [b"pot", room_id.to_le_bytes().as_ref()],
        bump = pot.bump,
    )]
    pub pot: Account<'info, Pot>,

    pub oracle: Signer<'info>,
}

#[derive(Accounts)]
#[instruction(room_id: u64)]
pub struct FinalizePot<'info> {
    #[account(
        seeds = [b"config"],
        bump = config.bump,
        has_one = oracle @ EscrowError::OracleOnly,
    )]
    pub config: Account<'info, ProgramConfig>,

    #[account(
        mut,
        seeds = [b"pot", room_id.to_le_bytes().as_ref()],
        bump = pot.bump,
        close = oracle,
    )]
    pub pot: Account<'info, Pot>,

    #[account(
        mut,
        seeds = [b"rake_vault"],
        bump = rake_vault.bump,
    )]
    pub rake_vault: Account<'info, RakeVault>,

    #[account(mut)]
    pub oracle: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(room_id: u64)]
pub struct RefundPot<'info> {
    #[account(
        seeds = [b"config"],
        bump = config.bump,
        has_one = oracle @ EscrowError::OracleOnly,
    )]
    pub config: Account<'info, ProgramConfig>,

    #[account(
        mut,
        seeds = [b"pot", room_id.to_le_bytes().as_ref()],
        bump = pot.bump,
        close = oracle,
    )]
    pub pot: Account<'info, Pot>,

    #[account(mut)]
    pub oracle: Signer<'info>,

    pub system_program: Program<'info, System>,
}

// --------------------------------------------------------------
// Phase C contexts: rake distribution
// --------------------------------------------------------------

#[derive(Accounts)]
pub struct InitRevShare<'info> {
    #[account(
        seeds = [b"config"],
        bump = config.bump,
        has_one = admin @ EscrowError::AdminOnly,
    )]
    pub config: Account<'info, ProgramConfig>,

    #[account(
        init,
        payer = admin,
        seeds = [b"rev_share"],
        bump,
        space = RevShareState::SPACE,
    )]
    pub rev_share: Account<'info, RevShareState>,

    #[account(
        init,
        payer = admin,
        seeds = [b"buyback_vault"],
        bump,
        space = BuybackVault::SPACE,
    )]
    pub buyback_vault: Account<'info, BuybackVault>,

    #[account(mut)]
    pub admin: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AdminUpdateRevShare<'info> {
    #[account(
        seeds = [b"config"],
        bump = config.bump,
        has_one = admin @ EscrowError::AdminOnly,
    )]
    pub config: Account<'info, ProgramConfig>,

    #[account(
        mut,
        seeds = [b"rev_share"],
        bump = rev_share.bump,
    )]
    pub rev_share: Account<'info, RevShareState>,

    pub admin: Signer<'info>,
}

#[derive(Accounts)]
pub struct AdminUpdateBuyback<'info> {
    #[account(
        seeds = [b"config"],
        bump = config.bump,
        has_one = admin @ EscrowError::AdminOnly,
    )]
    pub config: Account<'info, ProgramConfig>,

    #[account(
        mut,
        seeds = [b"buyback_vault"],
        bump = buyback_vault.bump,
    )]
    pub buyback_vault: Account<'info, BuybackVault>,

    pub admin: Signer<'info>,
}

#[derive(Accounts)]
pub struct DrainRakeVault<'info> {
    #[account(
        seeds = [b"config"],
        bump = config.bump,
        has_one = oracle @ EscrowError::OracleOnly,
    )]
    pub config: Account<'info, ProgramConfig>,

    #[account(
        mut,
        seeds = [b"rake_vault"],
        bump = rake_vault.bump,
    )]
    pub rake_vault: Account<'info, RakeVault>,

    #[account(
        mut,
        seeds = [b"rev_share"],
        bump = rev_share.bump,
    )]
    pub rev_share: Account<'info, RevShareState>,

    #[account(
        mut,
        seeds = [b"buyback_vault"],
        bump = buyback_vault.bump,
    )]
    pub buyback_vault: Account<'info, BuybackVault>,

    pub oracle: Signer<'info>,
}

#[derive(Accounts)]
pub struct ExecuteBuyback<'info> {
    #[account(
        seeds = [b"config"],
        bump = config.bump,
        has_one = admin @ EscrowError::AdminOnly,
    )]
    pub config: Account<'info, ProgramConfig>,

    #[account(
        mut,
        seeds = [b"buyback_vault"],
        bump = buyback_vault.bump,
    )]
    pub buyback_vault: Account<'info, BuybackVault>,

    /// CHECK: address verified against buyback_vault.receiver inside
    /// the instruction. Only matters that it's writable so we can
    /// credit it lamports.
    #[account(mut)]
    pub receiver: UncheckedAccount<'info>,

    pub admin: Signer<'info>,
}
