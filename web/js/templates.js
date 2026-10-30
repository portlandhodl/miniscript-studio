// Starter vaults. Policies use signer names; demo keys are derived per template.
import { estimateTipHeight } from './util.js';

const YEAR = 52_560; // blocks
const tipPlus = (blocks) => Math.ceil((estimateTipHeight() + blocks) / 1000) * 1000;

export const TEMPLATES = [
  {
    id: 'escape-hatch',
    name: 'Multi-vendor multisig + escape hatch',
    blurb: 'Day to day, 2 of 3 between you and two custody vendors. If the vendors disappear, your own key alone recovers the funds after a year.',
    context: 'wsh',
    policy: () => `or(99@thresh(2,pk(Vendor_A),pk(Vendor_B),pk(You)),1@and(pk(You),older(${YEAR})))`,
    keys: { Vendor_A: ['Vendor A', 'vendor'], Vendor_B: ['Vendor B', 'vendor'], You: ['You', 'hardware'] },
  },
  {
    id: 'decaying',
    name: 'Decaying multisig',
    blurb: '3 of 3 at first. After 6 months any 2 can spend, and after a year any 1. Lost keys get more forgivable over time.',
    context: 'wsh',
    policy: () => `thresh(3,pk(Alice),pk(Bob),pk(Carol),older(${YEAR / 2}),older(${YEAR}))`,
    keys: { Alice: ['Alice', 'hardware'], Bob: ['Bob', 'hardware'], Carol: ['Carol', 'cold'] },
  },
  {
    id: 'inheritance',
    name: 'Inheritance with a dead-man switch',
    blurb: 'The owner spends instantly through the Taproot key path. If coins sit untouched for a year, the heir can claim them.',
    context: 'tr',
    policy: () => `or(99@pk(Owner),1@and(pk(Heir),older(${YEAR})))`,
    keys: { Owner: ['Owner', 'hardware'], Heir: ['Heir', 'heir'] },
  },
  {
    id: 'social-recovery',
    name: 'Social recovery',
    blurb: 'Phone + hardware wallet for daily use. If both are lost, 2 of 3 trusted friends can recover after a 90-day delay.',
    context: 'tr',
    policy: () => `or(9@and(pk(Phone),pk(Hardware)),1@and(thresh(2,pk(Friend_1),pk(Friend_2),pk(Friend_3)),older(12960)))`,
    keys: {
      Phone: ['Phone', 'mobile'],
      Hardware: ['Hardware', 'hardware'],
      Friend_1: ['Friend 1', 'friend'],
      Friend_2: ['Friend 2', 'friend'],
      Friend_3: ['Friend 3', 'friend'],
    },
  },
  {
    id: 'collab-exit',
    name: 'Collaborative custody with a dated exit',
    blurb: 'You and a co-signing service hold the coins together. At a fixed block height about 2 years out, you can exit alone. An absolute timelock.',
    context: 'wsh',
    policy: () => `or(99@and(pk(You),pk(Service)),1@and(pk(You),after(${tipPlus(2 * YEAR)})))`,
    keys: { You: ['You', 'hardware'], Service: ['Service', 'vendor'] },
  },
  {
    id: 'htlc',
    name: 'Hash time-locked contract',
    blurb: 'The receiver claims by revealing a secret preimage. Otherwise the sender takes the coins back after a day. This is the building block of Lightning.',
    context: 'wsh',
    policy: () => `or(and(pk(Receiver),sha256(SECRET)),and(pk(Sender),older(144)))`,
    keys: { Receiver: ['Receiver', 'mobile'], Sender: ['Sender', 'mobile'] },
  },
  {
    id: 'blank',
    name: 'Blank canvas',
    blurb: 'Start from an empty wallet block and build your own policy.',
    context: 'wsh',
    policy: () => null,
    keys: {},
  },
];
