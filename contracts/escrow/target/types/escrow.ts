/**
 * Program IDL in camelCase format in order to be used in JS/TS.
 *
 * Note that this is only a type helper and is not the actual IDL. The original
 * IDL can be found at `target/idl/escrow.json`.
 */
export type Escrow = {
  "address": "DsFoEFQw6uPGgXDztmuPUozi1AqP9KWC6N71H2MLVG5z",
  "metadata": {
    "name": "escrow",
    "version": "0.1.0",
    "spec": "0.1.0",
    "description": "Created with Anchor"
  },
  "instructions": [
    {
      "name": "drainRakeVault",
      "docs": [
        "Oracle drains the rake_vault: 20% lands in buyback_vault, 80%",
        "stays as SOL in the rev_share account AND bumps the accumulator",
        "so NFT holders can later claim their share. The split is fixed",
        "at the program level (2000/8000 bps); Phase D could make it",
        "admin-configurable."
      ],
      "discriminator": [
        240,
        89,
        120,
        15,
        118,
        109,
        207,
        177
      ],
      "accounts": [
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "rakeVault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  97,
                  107,
                  101,
                  95,
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              }
            ]
          }
        },
        {
          "name": "revShare",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  101,
                  118,
                  95,
                  115,
                  104,
                  97,
                  114,
                  101
                ]
              }
            ]
          }
        },
        {
          "name": "buybackVault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  98,
                  117,
                  121,
                  98,
                  97,
                  99,
                  107,
                  95,
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              }
            ]
          }
        },
        {
          "name": "oracle",
          "signer": true,
          "relations": [
            "config"
          ]
        }
      ],
      "args": []
    },
    {
      "name": "executeBuyback",
      "docs": [
        "Admin moves SOL out of the buyback_vault to the configured",
        "receiver wallet. The receiver is the off-chain pipeline that",
        "swaps SOL → buyback SPL token and burns it. This is the only",
        "instruction that exits SOL from buyback_vault."
      ],
      "discriminator": [
        47,
        32,
        19,
        100,
        184,
        96,
        144,
        49
      ],
      "accounts": [
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "buybackVault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  98,
                  117,
                  121,
                  98,
                  97,
                  99,
                  107,
                  95,
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              }
            ]
          }
        },
        {
          "name": "receiver",
          "docs": [
            "the instruction. Only matters that it's writable so we can",
            "credit it lamports."
          ],
          "writable": true
        },
        {
          "name": "admin",
          "signer": true,
          "relations": [
            "config"
          ]
        }
      ],
      "args": []
    },
    {
      "name": "finalizePot",
      "docs": [
        "Oracle distributes the pot. winners[i] receives amounts[i]",
        "lamports; rake (computed from rake_bps) goes to the rake_vault",
        "PDA; remaining rent on the closed pot account refunds to the",
        "oracle.",
        "",
        "Each winner's account must be supplied as a remaining_account,",
        "in the same order as the winners list. Validation:",
        "- sum(amounts) + rake == sum_of_paid_entries",
        "- every winner is in pot.players",
        "- winners list has no duplicates"
      ],
      "discriminator": [
        65,
        142,
        16,
        89,
        109,
        39,
        43,
        161
      ],
      "accounts": [
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "pot",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  116
                ]
              },
              {
                "kind": "arg",
                "path": "roomId"
              }
            ]
          }
        },
        {
          "name": "rakeVault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  97,
                  107,
                  101,
                  95,
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              }
            ]
          }
        },
        {
          "name": "oracle",
          "writable": true,
          "signer": true,
          "relations": [
            "config"
          ]
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "roomId",
          "type": "u64"
        },
        {
          "name": "winners",
          "type": {
            "vec": "pubkey"
          }
        },
        {
          "name": "amounts",
          "type": {
            "vec": "u64"
          }
        }
      ]
    },
    {
      "name": "initConfig",
      "docs": [
        "One-time setup. Creates the singleton ProgramConfig and RakeVault",
        "PDAs. The admin (caller) becomes the only key allowed to flip",
        "settings or rotate the oracle. Rake basis-points default to 500",
        "(5%); admin can change later via `set_rake_bps`."
      ],
      "discriminator": [
        23,
        235,
        115,
        232,
        168,
        96,
        1,
        231
      ],
      "accounts": [
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "rakeVault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  97,
                  107,
                  101,
                  95,
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              }
            ]
          }
        },
        {
          "name": "admin",
          "writable": true,
          "signer": true
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "oracle",
          "type": "pubkey"
        }
      ]
    },
    {
      "name": "initPot",
      "docs": [
        "Oracle creates a fresh Pot for a quickmatch room. The pot is",
        "keyed by room_id (the server's room code, packed as u64 — short",
        "codes left-pad with zeros). Pot starts in Waiting state and",
        "accepts joins until the oracle calls start_pot."
      ],
      "discriminator": [
        12,
        101,
        65,
        99,
        215,
        68,
        153,
        102
      ],
      "accounts": [
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "pot",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  116
                ]
              },
              {
                "kind": "arg",
                "path": "roomId"
              }
            ]
          }
        },
        {
          "name": "oracle",
          "writable": true,
          "signer": true,
          "relations": [
            "config"
          ]
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "roomId",
          "type": "u64"
        },
        {
          "name": "entryFee",
          "type": "u64"
        }
      ]
    },
    {
      "name": "initRevShare",
      "docs": [
        "One-time setup for rake distribution. Creates the singleton",
        "RevShareState (with the configured NFT collection's supply)",
        "and BuybackVault PDAs. Admin specifies the buyback receiver",
        "wallet at init time; can be updated later via",
        "set_buyback_receiver."
      ],
      "discriminator": [
        255,
        13,
        195,
        161,
        13,
        218,
        253,
        154
      ],
      "accounts": [
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "revShare",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  101,
                  118,
                  95,
                  115,
                  104,
                  97,
                  114,
                  101
                ]
              }
            ]
          }
        },
        {
          "name": "buybackVault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  98,
                  117,
                  121,
                  98,
                  97,
                  99,
                  107,
                  95,
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              }
            ]
          }
        },
        {
          "name": "admin",
          "writable": true,
          "signer": true,
          "relations": [
            "config"
          ]
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "nftSupply",
          "type": "u64"
        },
        {
          "name": "buybackReceiver",
          "type": "pubkey"
        }
      ]
    },
    {
      "name": "joinPot",
      "docs": [
        "Player pays entry_fee into the pot and is recorded in the",
        "player list. Idempotency: the same key can't join twice. Pot",
        "must be in Waiting state and not already at MAX_PLAYERS."
      ],
      "discriminator": [
        249,
        78,
        206,
        230,
        11,
        66,
        198,
        165
      ],
      "accounts": [
        {
          "name": "pot",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "pot.room_id",
                "account": "pot"
              }
            ]
          }
        },
        {
          "name": "player",
          "writable": true,
          "signer": true
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "refundPot",
      "docs": [
        "Oracle refunds every paid player and closes the pot. Only valid",
        "while the pot is still Waiting — once start_pot fires, the round",
        "has begun and the next legal transition is finalize_pot. Used",
        "by the server when a paid quickmatch lobby gets cancelled",
        "before the round starts (e.g., a paid player leaves and we",
        "can't run a paid round with the remaining roster).",
        "",
        "Each player's wallet must be supplied as remaining_accounts[i],",
        "matching pot.players[i] one-for-one. The instruction pays each",
        "of them pot.entry_fee lamports; the pot's remaining lamports",
        "(rent-exempt minimum) refund to the oracle via close=oracle."
      ],
      "discriminator": [
        43,
        38,
        238,
        255,
        48,
        213,
        224,
        234
      ],
      "accounts": [
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "pot",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  116
                ]
              },
              {
                "kind": "arg",
                "path": "roomId"
              }
            ]
          }
        },
        {
          "name": "oracle",
          "writable": true,
          "signer": true,
          "relations": [
            "config"
          ]
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "roomId",
          "type": "u64"
        }
      ]
    },
    {
      "name": "setBuybackReceiver",
      "docs": [
        "Admin can rotate the buyback receiver wallet without",
        "touching anything else."
      ],
      "discriminator": [
        242,
        67,
        68,
        210,
        200,
        53,
        245,
        4
      ],
      "accounts": [
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "buybackVault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  98,
                  117,
                  121,
                  98,
                  97,
                  99,
                  107,
                  95,
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              }
            ]
          }
        },
        {
          "name": "admin",
          "signer": true,
          "relations": [
            "config"
          ]
        }
      ],
      "args": [
        {
          "name": "newReceiver",
          "type": "pubkey"
        }
      ]
    },
    {
      "name": "setBuybackToken",
      "docs": [
        "Admin sets the SPL token used for the buyback-and-burn rake",
        "destination. Default Pubkey::default() means \"not configured\" —",
        "Phase C will guard the buyback drain on this."
      ],
      "discriminator": [
        191,
        73,
        67,
        177,
        245,
        149,
        155,
        64
      ],
      "accounts": [
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "admin",
          "signer": true,
          "relations": [
            "config"
          ]
        }
      ],
      "args": [
        {
          "name": "mint",
          "type": "pubkey"
        }
      ]
    },
    {
      "name": "setNftCollection",
      "docs": [
        "Admin sets the NFT collection mint that's eligible for rev-share."
      ],
      "discriminator": [
        181,
        145,
        148,
        193,
        59,
        5,
        7,
        198
      ],
      "accounts": [
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "admin",
          "signer": true,
          "relations": [
            "config"
          ]
        }
      ],
      "args": [
        {
          "name": "collection",
          "type": "pubkey"
        }
      ]
    },
    {
      "name": "setNftSupply",
      "docs": [
        "Admin can adjust the NFT supply count (e.g., if the collection",
        "expands or contracts before public claims open)."
      ],
      "discriminator": [
        84,
        195,
        162,
        229,
        86,
        2,
        23,
        102
      ],
      "accounts": [
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "revShare",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  101,
                  118,
                  95,
                  115,
                  104,
                  97,
                  114,
                  101
                ]
              }
            ]
          }
        },
        {
          "name": "admin",
          "signer": true,
          "relations": [
            "config"
          ]
        }
      ],
      "args": [
        {
          "name": "newSupply",
          "type": "u64"
        }
      ]
    },
    {
      "name": "setOracle",
      "docs": [
        "Admin can rotate the oracle (e.g., when the server's keypair",
        "is replaced)."
      ],
      "discriminator": [
        186,
        128,
        81,
        104,
        74,
        79,
        18,
        224
      ],
      "accounts": [
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "admin",
          "signer": true,
          "relations": [
            "config"
          ]
        }
      ],
      "args": [
        {
          "name": "newOracle",
          "type": "pubkey"
        }
      ]
    },
    {
      "name": "setRakeBps",
      "docs": [
        "Admin can change rake (bounded so it can never exceed 100%)."
      ],
      "discriminator": [
        157,
        34,
        205,
        53,
        229,
        52,
        74,
        181
      ],
      "accounts": [
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "admin",
          "signer": true,
          "relations": [
            "config"
          ]
        }
      ],
      "args": [
        {
          "name": "rakeBps",
          "type": "u16"
        }
      ]
    },
    {
      "name": "startPot",
      "docs": [
        "Oracle marks the pot as in-progress. Joins are rejected after",
        "this. Called when the lobby countdown ends or skip-timer fires."
      ],
      "discriminator": [
        181,
        107,
        192,
        210,
        244,
        97,
        102,
        97
      ],
      "accounts": [
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "pot",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  116
                ]
              },
              {
                "kind": "arg",
                "path": "roomId"
              }
            ]
          }
        },
        {
          "name": "oracle",
          "signer": true,
          "relations": [
            "config"
          ]
        }
      ],
      "args": [
        {
          "name": "roomId",
          "type": "u64"
        }
      ]
    }
  ],
  "accounts": [
    {
      "name": "buybackVault",
      "discriminator": [
        153,
        166,
        71,
        144,
        179,
        189,
        137,
        251
      ]
    },
    {
      "name": "pot",
      "discriminator": [
        238,
        118,
        60,
        175,
        178,
        191,
        59,
        58
      ]
    },
    {
      "name": "programConfig",
      "discriminator": [
        196,
        210,
        90,
        231,
        144,
        149,
        140,
        63
      ]
    },
    {
      "name": "rakeVault",
      "discriminator": [
        125,
        243,
        182,
        51,
        25,
        202,
        195,
        14
      ]
    },
    {
      "name": "revShareState",
      "discriminator": [
        104,
        244,
        77,
        142,
        39,
        190,
        165,
        47
      ]
    }
  ],
  "errors": [
    {
      "code": 6000,
      "name": "potNotOpen",
      "msg": "pot is not open for joining"
    },
    {
      "code": 6001,
      "name": "potFull",
      "msg": "pot already has the maximum players"
    },
    {
      "code": 6002,
      "name": "alreadyJoined",
      "msg": "player has already joined this pot"
    },
    {
      "code": 6003,
      "name": "wrongState",
      "msg": "pot is in the wrong state for this operation"
    },
    {
      "code": 6004,
      "name": "payoutMismatch",
      "msg": "payout list and amounts inconsistent (or sum != pot - rake)"
    },
    {
      "code": 6005,
      "name": "winnerMismatch",
      "msg": "winner pubkey doesn't match the corresponding remaining_account"
    },
    {
      "code": 6006,
      "name": "nonPlayerWinner",
      "msg": "winner is not in the pot's player list"
    },
    {
      "code": 6007,
      "name": "duplicateWinner",
      "msg": "winners list contains a duplicate"
    },
    {
      "code": 6008,
      "name": "oracleOnly",
      "msg": "only the configured oracle may call this instruction"
    },
    {
      "code": 6009,
      "name": "adminOnly",
      "msg": "only the admin may call this instruction"
    },
    {
      "code": 6010,
      "name": "invalidEntryFee",
      "msg": "entry fee must be greater than zero"
    },
    {
      "code": 6011,
      "name": "invalidRake",
      "msg": "rake basis-points must be at most 10000"
    },
    {
      "code": 6012,
      "name": "overflow",
      "msg": "arithmetic overflow"
    },
    {
      "code": 6013,
      "name": "invalidNftSupply",
      "msg": "nft_supply must be greater than zero"
    },
    {
      "code": 6014,
      "name": "nothingToDrain",
      "msg": "nothing left to drain in this vault"
    },
    {
      "code": 6015,
      "name": "buybackReceiverMismatch",
      "msg": "provided receiver doesn't match the configured buyback receiver"
    },
    {
      "code": 6016,
      "name": "revShareNotInitialized",
      "msg": "rev_share or buyback vault is not initialized"
    },
    {
      "code": 6017,
      "name": "notInCollection",
      "msg": "nft does not belong to the configured collection"
    },
    {
      "code": 6018,
      "name": "notNftHolder",
      "msg": "caller does not hold the NFT being claimed"
    }
  ],
  "types": [
    {
      "name": "buybackVault",
      "docs": [
        "Buyback SOL bag. Holds 20% of every rake drain. `receiver` is the",
        "wallet that's authorized to pull funds out (admin sets it via",
        "set_buyback_receiver). The off-chain pipeline behind that wallet",
        "swaps SOL for the configured buyback SPL token and burns it."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "receiver",
            "type": "pubkey"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "pot",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "roomId",
            "type": "u64"
          },
          {
            "name": "entryFee",
            "type": "u64"
          },
          {
            "name": "state",
            "type": "u8"
          },
          {
            "name": "players",
            "type": {
              "vec": "pubkey"
            }
          },
          {
            "name": "createdAt",
            "type": "i64"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "programConfig",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "admin",
            "type": "pubkey"
          },
          {
            "name": "oracle",
            "type": "pubkey"
          },
          {
            "name": "rakeBps",
            "type": "u16"
          },
          {
            "name": "buybackMint",
            "type": "pubkey"
          },
          {
            "name": "nftCollection",
            "type": "pubkey"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "rakeVault",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "revShareState",
      "docs": [
        "Synthetix-style accumulator for NFT-holder revenue share. Every",
        "drain_rake_vault adds (rev_share_amount * PRECISION / nft_supply)",
        "to `total_accrued_per_unit`. Each NFT-holder's claim equals",
        "(total_accrued_per_unit - their last_claimed_per_unit) / PRECISION.",
        "The PRECISION scaler (1e12) keeps division loss < 1 lamport per NFT",
        "per drain even for small drains against a 10k-supply collection."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "totalAccruedPerUnit",
            "type": "u128"
          },
          {
            "name": "nftSupply",
            "type": "u64"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    }
  ]
};
