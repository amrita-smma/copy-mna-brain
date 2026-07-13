import type { Fund, Investor } from './types';

// Seed data ported from the Fund Management mockup. This is the single source
// of truth for the initial funds/holdings/investors; edit here to change what
// the page loads. (Kept as a typed TS module rather than a fetched JSON file.)
export const SEED_FUNDS: Fund[] = [
  {
    "id": "1",
    "n": "Direct Investments",
    "v": 2018,
    "size": 195.83,
    "called": 195.83,
    "calledPct": 100,
    "fmv": 195.83,
    "real": 0,
    "dpi": 0,
    "tvpi": 1,
    "irr": 11.2,
    "st": "Investing",
    "hist": {
      "committed": [
        186.04,
        189.96,
        193.87,
        195.83
      ],
      "called": [
        180.16,
        186.04,
        191.91,
        195.83
      ],
      "fmv": [
        184.08,
        188,
        191.91,
        195.83
      ]
    },
    "h": [
      {
        "n": "Akulaku",
        "tp": "Equity",
        "dt": "Sep 2021",
        "cost": 6.63,
        "fmv": 6.63,
        "real": 0,
        "moic": 1,
        "st": "Active",
        "investType": "Direct Investment",
        "d": {
          "entity": "Meranti Global Investment Ltd",
          "fundingSource": "Aldiracita, Hawthorn",
          "structure": "EPA",
          "mgmtFeeRate": 2,
          "description": "Southeast Asia Digital Finance",
          "holdYrs": 4.6,
          "geo": "Southeast Asia",
          "sheet": "AKUL"
        },
        "inv": {
          "legalName": "Akulaku",
          "entity": "Meranti Global Investment Ltd",
          "investType": "Direct Investment",
          "fundingSource": "Aldiracita, Hawthorn",
          "mgmtFeeRate": 2,
          "prefReturnRate": 8,
          "carryRate": 10,
          "stakePct": null,
          "reportDate": "31 Mar 2026",
          "investCcy": "USD",
          "ccy": "USD",
          "description": "Southeast Asia Digital Finance",
          "keyRights": "",
          "txns": [
            {
              "date": "Sep 2021",
              "eom": null,
              "type": "Buy",
              "value": 6.63,
              "fx": null,
              "notes": "AKUL"
            }
          ],
          "quarterly": [
            {
              "q": "Q1'26",
              "mv": 6.63,
              "cost": 6.63,
              "pps": null,
              "sharesOut": null,
              "shPct": null,
              "moic": 1,
              "xirr": null,
              "notes": "CAS"
            }
          ]
        }
      },
      {
        "n": "Coco",
        "tp": "Equity",
        "dt": "Sep 2021",
        "cost": 7.02,
        "fmv": 7.02,
        "real": 0,
        "moic": 1,
        "st": "Active",
        "investType": "Direct Investment",
        "d": {
          "entity": "Mahogany Global Investment Pte Ltd",
          "fundingSource": "DCA",
          "structure": "EPA",
          "mgmtFeeRate": 2,
          "description": "",
          "holdYrs": 4.6,
          "geo": "Southeast Asia",
          "sheet": "COCO"
        },
        "inv": {
          "legalName": "Coco",
          "entity": "Mahogany Global Investment Pte Ltd",
          "investType": "Direct Investment",
          "fundingSource": "DCA",
          "mgmtFeeRate": 2,
          "prefReturnRate": 8,
          "carryRate": 10,
          "stakePct": null,
          "reportDate": "31 Mar 2026",
          "investCcy": "USD",
          "ccy": "USD",
          "description": "",
          "keyRights": "",
          "txns": [
            {
              "date": "Sep 2021",
              "eom": null,
              "type": "Buy",
              "value": 7.02,
              "fx": null,
              "notes": "COCO"
            }
          ],
          "quarterly": [
            {
              "q": "Q1'26",
              "mv": 7.02,
              "cost": 7.02,
              "pps": null,
              "sharesOut": null,
              "shPct": null,
              "moic": 1,
              "xirr": null,
              "notes": "CAS"
            }
          ]
        }
      },
      {
        "n": "Metmask",
        "tp": "Equity",
        "dt": "Feb 2022",
        "cost": 2.16,
        "fmv": 2.16,
        "real": 0,
        "moic": 1,
        "st": "Active",
        "investType": "Direct Investment",
        "d": {
          "entity": "Meranti Global Investment Ltd",
          "fundingSource": "DCA",
          "structure": "EPA",
          "mgmtFeeRate": 2,
          "description": "",
          "holdYrs": 4.2,
          "geo": "Southeast Asia",
          "sheet": "META"
        },
        "inv": {
          "legalName": "Metmask",
          "entity": "Meranti Global Investment Ltd",
          "investType": "Direct Investment",
          "fundingSource": "DCA",
          "mgmtFeeRate": 2,
          "prefReturnRate": 8,
          "carryRate": 10,
          "stakePct": null,
          "reportDate": "31 Mar 2026",
          "investCcy": "USD",
          "ccy": "USD",
          "description": "",
          "keyRights": "",
          "txns": [
            {
              "date": "Feb 2022",
              "eom": null,
              "type": "Buy",
              "value": 2.16,
              "fx": null,
              "notes": "META"
            }
          ],
          "quarterly": [
            {
              "q": "Q1'26",
              "mv": 2.16,
              "cost": 2.16,
              "pps": null,
              "sharesOut": null,
              "shPct": null,
              "moic": 1,
              "xirr": null,
              "notes": "CAS"
            }
          ]
        }
      },
      {
        "n": "Sirclo",
        "tp": "Equity",
        "dt": "Jul 2021",
        "cost": 1,
        "fmv": 1,
        "real": 0,
        "moic": 1,
        "st": "Active",
        "investType": "Direct Investment",
        "d": {
          "entity": "Meranti Global Investment Ltd",
          "fundingSource": "DCA",
          "structure": "EPA",
          "mgmtFeeRate": 2,
          "description": "E-Commerce Enabler",
          "holdYrs": 4.7,
          "geo": "Southeast Asia",
          "sheet": "SIRC"
        },
        "inv": {
          "legalName": "Sirclo",
          "entity": "Meranti Global Investment Ltd",
          "investType": "Direct Investment",
          "fundingSource": "DCA",
          "mgmtFeeRate": 2,
          "prefReturnRate": 8,
          "carryRate": 10,
          "stakePct": null,
          "reportDate": "31 Mar 2026",
          "investCcy": "USD",
          "ccy": "USD",
          "description": "E-Commerce Enabler",
          "keyRights": "",
          "txns": [
            {
              "date": "Jul 2021",
              "eom": null,
              "type": "Buy",
              "value": 1,
              "fx": null,
              "notes": "SIRC"
            }
          ],
          "quarterly": [
            {
              "q": "Q1'26",
              "mv": 1,
              "cost": 1,
              "pps": null,
              "sharesOut": null,
              "shPct": null,
              "moic": 1,
              "xirr": null,
              "notes": "CAS"
            }
          ]
        }
      },
      {
        "n": "Cicil",
        "tp": "Equity",
        "dt": "Apr 2022",
        "cost": 0.33,
        "fmv": 0.33,
        "real": 0,
        "moic": 1,
        "st": "Active",
        "investType": "Direct Investment",
        "d": {
          "entity": "Meranti Global Investment Ltd",
          "fundingSource": "DCA",
          "structure": "EPA",
          "mgmtFeeRate": 2,
          "description": "Digital Finance",
          "holdYrs": 4,
          "geo": "Southeast Asia",
          "sheet": "CICL"
        },
        "inv": {
          "legalName": "Cicil",
          "entity": "Meranti Global Investment Ltd",
          "investType": "Direct Investment",
          "fundingSource": "DCA",
          "mgmtFeeRate": 2,
          "prefReturnRate": 8,
          "carryRate": 10,
          "stakePct": null,
          "reportDate": "31 Mar 2026",
          "investCcy": "USD",
          "ccy": "USD",
          "description": "Digital Finance",
          "keyRights": "",
          "txns": [
            {
              "date": "Apr 2022",
              "eom": null,
              "type": "Buy",
              "value": 0.33,
              "fx": null,
              "notes": "CICL"
            }
          ],
          "quarterly": [
            {
              "q": "Q1'26",
              "mv": 0.33,
              "cost": 0.33,
              "pps": null,
              "sharesOut": null,
              "shPct": null,
              "moic": 1,
              "xirr": null,
              "notes": "CAS"
            }
          ]
        }
      },
      {
        "n": "GOTO Group",
        "tp": "Equity",
        "dt": "Jan 2018",
        "cost": 43.78,
        "fmv": 43.78,
        "real": 0,
        "moic": 1,
        "st": "Active",
        "investType": "Direct Investment",
        "d": {
          "entity": "Asia Star Fund Ltd, Meranti Global Investment Ltd, Hawthorn Limited",
          "fundingSource": "DCA",
          "structure": "EPA",
          "mgmtFeeRate": 2,
          "description": "Indonesian Ride-Hailing Platform",
          "holdYrs": 8.2,
          "geo": "Southeast Asia",
          "sheet": "GOTO"
        },
        "inv": {
          "legalName": "GOTO Group",
          "entity": "Asia Star Fund Ltd, Meranti Global Investment Ltd, Hawthorn Limited",
          "investType": "Direct Investment",
          "fundingSource": "DCA",
          "mgmtFeeRate": 2,
          "prefReturnRate": 8,
          "carryRate": 10,
          "stakePct": null,
          "reportDate": "31 Mar 2026",
          "investCcy": "USD",
          "ccy": "USD",
          "description": "Indonesian Ride-Hailing Platform",
          "keyRights": "",
          "txns": [
            {
              "date": "Jan 2018",
              "eom": null,
              "type": "Buy",
              "value": 43.78,
              "fx": null,
              "notes": "GOTO"
            }
          ],
          "quarterly": [
            {
              "q": "Q1'26",
              "mv": 43.78,
              "cost": 43.78,
              "pps": null,
              "sharesOut": null,
              "shPct": null,
              "moic": 1,
              "xirr": null,
              "notes": "CAS"
            }
          ]
        }
      },
      {
        "n": "Viva Health",
        "tp": "Equity",
        "dt": "Aug 2020",
        "cost": 10.33,
        "fmv": 10.33,
        "real": 0,
        "moic": 1,
        "st": "Active",
        "investType": "Direct Investment",
        "d": {
          "entity": "Meranti Global Investment Ltd & Startech Growth VCC",
          "fundingSource": "SMMA, NIC",
          "structure": "Mgmt Fee",
          "mgmtFeeRate": 2,
          "description": "",
          "holdYrs": 5.7,
          "geo": "Southeast Asia",
          "sheet": "VIVA"
        },
        "inv": {
          "legalName": "Viva Health",
          "entity": "Meranti Global Investment Ltd & Startech Growth VCC",
          "investType": "Direct Investment",
          "fundingSource": "SMMA, NIC",
          "mgmtFeeRate": 2,
          "prefReturnRate": 8,
          "carryRate": 10,
          "stakePct": null,
          "reportDate": "31 Mar 2026",
          "investCcy": "USD",
          "ccy": "USD",
          "description": "",
          "keyRights": "",
          "txns": [
            {
              "date": "Aug 2020",
              "eom": null,
              "type": "Buy",
              "value": 10.33,
              "fx": null,
              "notes": "VIVA"
            }
          ],
          "quarterly": [
            {
              "q": "Q1'26",
              "mv": 10.33,
              "cost": 10.33,
              "pps": null,
              "sharesOut": null,
              "shPct": null,
              "moic": 1,
              "xirr": null,
              "notes": "CAS"
            }
          ]
        }
      },
      {
        "n": "Sayurbox",
        "tp": "Equity",
        "dt": "Apr 2020",
        "cost": 0.68,
        "fmv": 0.68,
        "real": 0,
        "moic": 1,
        "st": "Active",
        "investType": "Direct Investment",
        "d": {
          "entity": "Walker Strategic Investments Inc",
          "fundingSource": "DCA",
          "structure": "Mgmt Fee",
          "mgmtFeeRate": 2,
          "description": "B2B Agri Platform",
          "holdYrs": 6,
          "geo": "Southeast Asia",
          "sheet": "SBOX"
        },
        "inv": {
          "legalName": "Sayurbox",
          "entity": "Walker Strategic Investments Inc",
          "investType": "Direct Investment",
          "fundingSource": "DCA",
          "mgmtFeeRate": 2,
          "prefReturnRate": 8,
          "carryRate": 10,
          "stakePct": null,
          "reportDate": "31 Mar 2026",
          "investCcy": "USD",
          "ccy": "USD",
          "description": "B2B Agri Platform",
          "keyRights": "",
          "txns": [
            {
              "date": "Apr 2020",
              "eom": null,
              "type": "Buy",
              "value": 0.68,
              "fx": null,
              "notes": "SBOX"
            }
          ],
          "quarterly": [
            {
              "q": "Q1'26",
              "mv": 0.68,
              "cost": 0.68,
              "pps": null,
              "sharesOut": null,
              "shPct": null,
              "moic": 1,
              "xirr": null,
              "notes": "CAS"
            }
          ]
        }
      },
      {
        "n": "Funderbeam",
        "tp": "Equity",
        "dt": "May 2019",
        "cost": 0.22,
        "fmv": 0.22,
        "real": 0,
        "moic": 1,
        "st": "Active",
        "investType": "Direct Investment",
        "d": {
          "entity": "Startech Growth Fund VCC",
          "fundingSource": "NIC",
          "structure": "Mgmt Fee",
          "mgmtFeeRate": 1.35,
          "description": "European Investing Platform",
          "holdYrs": 6.9,
          "geo": "Southeast Asia",
          "sheet": "BEAM"
        },
        "inv": {
          "legalName": "Funderbeam",
          "entity": "Startech Growth Fund VCC",
          "investType": "Direct Investment",
          "fundingSource": "NIC",
          "mgmtFeeRate": 1.35,
          "prefReturnRate": 8,
          "carryRate": 10,
          "stakePct": null,
          "reportDate": "31 Mar 2026",
          "investCcy": "USD",
          "ccy": "USD",
          "description": "European Investing Platform",
          "keyRights": "",
          "txns": [
            {
              "date": "May 2019",
              "eom": null,
              "type": "Buy",
              "value": 0.22,
              "fx": null,
              "notes": "BEAM"
            }
          ],
          "quarterly": [
            {
              "q": "Q1'26",
              "mv": 0.22,
              "cost": 0.22,
              "pps": null,
              "sharesOut": null,
              "shPct": null,
              "moic": 1,
              "xirr": null,
              "notes": "CAS"
            }
          ]
        }
      },
      {
        "n": "Alto Pharmaceutical",
        "tp": "Equity",
        "dt": "Jun 2021",
        "cost": 2.04,
        "fmv": 2.04,
        "real": 0,
        "moic": 1,
        "st": "Active",
        "investType": "Direct Investment",
        "d": {
          "entity": "Startech Growth Fund VCC",
          "fundingSource": "NIC",
          "structure": "Mgmt Fee",
          "mgmtFeeRate": 1.35,
          "description": "Online Pharmacy",
          "holdYrs": 4.8,
          "geo": "Southeast Asia",
          "sheet": "ALTO"
        },
        "inv": {
          "legalName": "Alto Pharmaceutical",
          "entity": "Startech Growth Fund VCC",
          "investType": "Direct Investment",
          "fundingSource": "NIC",
          "mgmtFeeRate": 1.35,
          "prefReturnRate": 8,
          "carryRate": 10,
          "stakePct": null,
          "reportDate": "31 Mar 2026",
          "investCcy": "USD",
          "ccy": "USD",
          "description": "Online Pharmacy",
          "keyRights": "",
          "txns": [
            {
              "date": "Jun 2021",
              "eom": null,
              "type": "Buy",
              "value": 2.04,
              "fx": null,
              "notes": "ALTO"
            }
          ],
          "quarterly": [
            {
              "q": "Q1'26",
              "mv": 2.04,
              "cost": 2.04,
              "pps": null,
              "sharesOut": null,
              "shPct": null,
              "moic": 1,
              "xirr": null,
              "notes": "CAS"
            }
          ]
        }
      },
      {
        "n": "Horizon Robotics",
        "tp": "Equity",
        "dt": "Aug 2022",
        "cost": 3.4,
        "fmv": 3.4,
        "real": 0,
        "moic": 1,
        "st": "Active",
        "investType": "Direct Investment",
        "d": {
          "entity": "Startech Growth Fund VCC",
          "fundingSource": "NIC",
          "structure": "Mgmt Fee",
          "mgmtFeeRate": 1.35,
          "description": "Smart Driving Solutions Technology",
          "holdYrs": 3.7,
          "geo": "Southeast Asia",
          "sheet": "HRZN"
        },
        "inv": {
          "legalName": "Horizon Robotics",
          "entity": "Startech Growth Fund VCC",
          "investType": "Direct Investment",
          "fundingSource": "NIC",
          "mgmtFeeRate": 1.35,
          "prefReturnRate": 8,
          "carryRate": 10,
          "stakePct": null,
          "reportDate": "31 Mar 2026",
          "investCcy": "USD",
          "ccy": "USD",
          "description": "Smart Driving Solutions Technology",
          "keyRights": "",
          "txns": [
            {
              "date": "Aug 2022",
              "eom": null,
              "type": "Buy",
              "value": 3.4,
              "fx": null,
              "notes": "HRZN"
            }
          ],
          "quarterly": [
            {
              "q": "Q1'26",
              "mv": 3.4,
              "cost": 3.4,
              "pps": null,
              "sharesOut": null,
              "shPct": null,
              "moic": 1,
              "xirr": null,
              "notes": "CAS"
            }
          ]
        }
      },
      {
        "n": "Agriaku",
        "tp": "Equity",
        "dt": "May 2023",
        "cost": 2,
        "fmv": 2,
        "real": 0,
        "moic": 1,
        "st": "Active",
        "investType": "Direct Investment",
        "d": {
          "entity": "Startech Growth Fund VCC",
          "fundingSource": "NIC",
          "structure": "Mgmt Fee",
          "mgmtFeeRate": 1.35,
          "description": "B2B Agritech",
          "holdYrs": 2.9,
          "geo": "Southeast Asia",
          "sheet": "AGRI"
        },
        "inv": {
          "legalName": "Agriaku",
          "entity": "Startech Growth Fund VCC",
          "investType": "Direct Investment",
          "fundingSource": "NIC",
          "mgmtFeeRate": 1.35,
          "prefReturnRate": 8,
          "carryRate": 10,
          "stakePct": null,
          "reportDate": "31 Mar 2026",
          "investCcy": "USD",
          "ccy": "USD",
          "description": "B2B Agritech",
          "keyRights": "",
          "txns": [
            {
              "date": "May 2023",
              "eom": null,
              "type": "Buy",
              "value": 2,
              "fx": null,
              "notes": "AGRI"
            }
          ],
          "quarterly": [
            {
              "q": "Q1'26",
              "mv": 2,
              "cost": 2,
              "pps": null,
              "sharesOut": null,
              "shPct": null,
              "moic": 1,
              "xirr": null,
              "notes": "CAS"
            }
          ]
        }
      },
      {
        "n": "WeLab Sky Limited",
        "tp": "Equity",
        "dt": "Jun 2022",
        "cost": 2,
        "fmv": 2,
        "real": 0,
        "moic": 1,
        "st": "Active",
        "investType": "Direct Investment",
        "d": {
          "entity": "Startech Growth Fund VCC",
          "fundingSource": "NIC",
          "structure": "Mgmt Fee",
          "mgmtFeeRate": 1.35,
          "description": "Fintech Holding",
          "holdYrs": 3.8,
          "geo": "Southeast Asia",
          "sheet": "WLAB"
        },
        "inv": {
          "legalName": "WeLab Sky Limited",
          "entity": "Startech Growth Fund VCC",
          "investType": "Direct Investment",
          "fundingSource": "NIC",
          "mgmtFeeRate": 1.35,
          "prefReturnRate": 8,
          "carryRate": 10,
          "stakePct": null,
          "reportDate": "31 Mar 2026",
          "investCcy": "USD",
          "ccy": "USD",
          "description": "Fintech Holding",
          "keyRights": "",
          "txns": [
            {
              "date": "Jun 2022",
              "eom": null,
              "type": "Buy",
              "value": 2,
              "fx": null,
              "notes": "WLAB"
            }
          ],
          "quarterly": [
            {
              "q": "Q1'26",
              "mv": 2,
              "cost": 2,
              "pps": null,
              "sharesOut": null,
              "shPct": null,
              "moic": 1,
              "xirr": null,
              "notes": "CAS"
            }
          ]
        }
      },
      {
        "n": "Interopera",
        "tp": "Equity",
        "dt": "Apr 2022",
        "cost": 1,
        "fmv": 1,
        "real": 0,
        "moic": 1,
        "st": "Active",
        "investType": "Direct Investment",
        "d": {
          "entity": "Startech Growth Fund VCC",
          "fundingSource": "NIC",
          "structure": "Mgmt Fee",
          "mgmtFeeRate": 1.35,
          "description": "AI Workflow Platform",
          "holdYrs": 4,
          "geo": "Southeast Asia",
          "sheet": "INOP"
        },
        "inv": {
          "legalName": "Interopera",
          "entity": "Startech Growth Fund VCC",
          "investType": "Direct Investment",
          "fundingSource": "NIC",
          "mgmtFeeRate": 1.35,
          "prefReturnRate": 8,
          "carryRate": 10,
          "stakePct": null,
          "reportDate": "31 Mar 2026",
          "investCcy": "USD",
          "ccy": "USD",
          "description": "AI Workflow Platform",
          "keyRights": "",
          "txns": [
            {
              "date": "Apr 2022",
              "eom": null,
              "type": "Buy",
              "value": 1,
              "fx": null,
              "notes": "INOP"
            }
          ],
          "quarterly": [
            {
              "q": "Q1'26",
              "mv": 1,
              "cost": 1,
              "pps": null,
              "sharesOut": null,
              "shPct": null,
              "moic": 1,
              "xirr": null,
              "notes": "CAS"
            }
          ]
        }
      },
      {
        "n": "PT Energi Jaya Inovasi",
        "tp": "Equity",
        "dt": "Dec 2025",
        "cost": 2,
        "fmv": 2,
        "real": 0,
        "moic": 1,
        "st": "Active",
        "investType": "Direct Investment",
        "d": {
          "entity": "Startech Growth Fund VCC",
          "fundingSource": "NIC",
          "structure": "Mgmt Fee",
          "mgmtFeeRate": 1.35,
          "description": "",
          "holdYrs": 0.5,
          "geo": "Southeast Asia",
          "sheet": "NIRA"
        },
        "inv": {
          "legalName": "PT Energi Jaya Inovasi",
          "entity": "Startech Growth Fund VCC",
          "investType": "Direct Investment",
          "fundingSource": "NIC",
          "mgmtFeeRate": 1.35,
          "prefReturnRate": 8,
          "carryRate": 10,
          "stakePct": null,
          "reportDate": "31 Mar 2026",
          "investCcy": "USD",
          "ccy": "USD",
          "description": "",
          "keyRights": "",
          "txns": [
            {
              "date": "Dec 2025",
              "eom": null,
              "type": "Buy",
              "value": 2,
              "fx": null,
              "notes": "NIRA"
            }
          ],
          "quarterly": [
            {
              "q": "Q1'26",
              "mv": 2,
              "cost": 2,
              "pps": null,
              "sharesOut": null,
              "shPct": null,
              "moic": 1,
              "xirr": null,
              "notes": "CAS"
            }
          ]
        }
      },
      {
        "n": "PT Euro Medika",
        "tp": "Equity",
        "dt": "Nov 2025",
        "cost": 24.78,
        "fmv": 24.78,
        "real": 0,
        "moic": 1,
        "st": "Active",
        "investType": "Direct Investment",
        "d": {
          "entity": "Startech Growth Fund VCC",
          "fundingSource": "NIC",
          "structure": "Mgmt Fee",
          "mgmtFeeRate": 1.35,
          "description": "",
          "holdYrs": 0.5,
          "geo": "Southeast Asia",
          "sheet": "EURO"
        },
        "inv": {
          "legalName": "PT Euro Medika",
          "entity": "Startech Growth Fund VCC",
          "investType": "Direct Investment",
          "fundingSource": "NIC",
          "mgmtFeeRate": 1.35,
          "prefReturnRate": 8,
          "carryRate": 10,
          "stakePct": null,
          "reportDate": "31 Mar 2026",
          "investCcy": "USD",
          "ccy": "USD",
          "description": "",
          "keyRights": "",
          "txns": [
            {
              "date": "Nov 2025",
              "eom": null,
              "type": "Buy",
              "value": 24.78,
              "fx": null,
              "notes": "EURO"
            }
          ],
          "quarterly": [
            {
              "q": "Q1'26",
              "mv": 24.78,
              "cost": 24.78,
              "pps": null,
              "sharesOut": null,
              "shPct": null,
              "moic": 1,
              "xirr": null,
              "notes": "CAS"
            }
          ]
        }
      },
      {
        "n": "River Pharma APAC",
        "tp": "Equity",
        "dt": "Feb 2023",
        "cost": 1.87,
        "fmv": 1.87,
        "real": 0,
        "moic": 1,
        "st": "Active",
        "investType": "Direct Investment",
        "d": {
          "entity": "Startech Partners Ltd",
          "fundingSource": "NA",
          "structure": "",
          "mgmtFeeRate": 1.35,
          "description": "Pharmaceutical Distribution",
          "holdYrs": 3.2,
          "geo": "Southeast Asia",
          "sheet": "RPHA"
        },
        "inv": {
          "legalName": "River Pharma APAC",
          "entity": "Startech Partners Ltd",
          "investType": "Direct Investment",
          "fundingSource": "NA",
          "mgmtFeeRate": 1.35,
          "prefReturnRate": 8,
          "carryRate": 10,
          "stakePct": null,
          "reportDate": "31 Mar 2026",
          "investCcy": "USD",
          "ccy": "USD",
          "description": "Pharmaceutical Distribution",
          "keyRights": "",
          "txns": [
            {
              "date": "Feb 2023",
              "eom": null,
              "type": "Buy",
              "value": 1.87,
              "fx": null,
              "notes": "RPHA"
            }
          ],
          "quarterly": [
            {
              "q": "Q1'26",
              "mv": 1.87,
              "cost": 1.87,
              "pps": null,
              "sharesOut": null,
              "shPct": null,
              "moic": 1,
              "xirr": null,
              "notes": "CAS"
            }
          ]
        }
      },
      {
        "n": "Entomo",
        "tp": "Equity",
        "dt": "Dec 2018",
        "cost": 2.86,
        "fmv": 2.86,
        "real": 0,
        "moic": 1,
        "st": "Active",
        "investType": "Direct Investment",
        "d": {
          "entity": "Zelkova Capital Investment Pte Ltd",
          "fundingSource": "NA",
          "structure": "",
          "mgmtFeeRate": 1.35,
          "description": "Indonesian HR Software Platform",
          "holdYrs": 7.3,
          "geo": "Southeast Asia",
          "sheet": "ENTM"
        },
        "inv": {
          "legalName": "Entomo",
          "entity": "Zelkova Capital Investment Pte Ltd",
          "investType": "Direct Investment",
          "fundingSource": "NA",
          "mgmtFeeRate": 1.35,
          "prefReturnRate": 8,
          "carryRate": 10,
          "stakePct": null,
          "reportDate": "31 Mar 2026",
          "investCcy": "USD",
          "ccy": "USD",
          "description": "Indonesian HR Software Platform",
          "keyRights": "",
          "txns": [
            {
              "date": "Dec 2018",
              "eom": null,
              "type": "Buy",
              "value": 2.86,
              "fx": null,
              "notes": "ENTM"
            }
          ],
          "quarterly": [
            {
              "q": "Q1'26",
              "mv": 2.86,
              "cost": 2.86,
              "pps": null,
              "sharesOut": null,
              "shPct": null,
              "moic": 1,
              "xirr": null,
              "notes": "CAS"
            }
          ]
        }
      },
      {
        "n": "Mythic Protocol",
        "tp": "Obligation",
        "dt": "Feb 2023",
        "cost": 0.5,
        "fmv": 0.5,
        "real": 0,
        "moic": 1,
        "st": "Active",
        "investType": "Others",
        "d": {
          "noteType": "Loan",
          "issuer": "Mythic Protocol",
          "principal": 0.5,
          "fundingSource": "Berau Coal",
          "entity": "Nano Digital Technology Ltd (BVI)",
          "structure": "Loan",
          "description": "Web3 Collaborative Game Ecosystem",
          "holdYrs": 3.2,
          "sheet": "MYTH"
        }
      },
      {
        "n": "Cambridge Quantum",
        "tp": "Obligation",
        "dt": "Mar 2022",
        "cost": 3.41,
        "fmv": 3.41,
        "real": 0,
        "moic": 1,
        "st": "Active",
        "investType": "Others",
        "d": {
          "noteType": "Loan",
          "issuer": "Cambridge Quantum",
          "principal": 3.41,
          "fundingSource": "NA",
          "entity": "Meranti Global Investment Ltd",
          "structure": "Loan",
          "description": "",
          "holdYrs": 4.1,
          "sheet": "QNTM"
        }
      },
      {
        "n": "Fore Coffee",
        "tp": "Equity",
        "dt": "Apr 2019",
        "cost": 0.55,
        "fmv": 0.55,
        "real": 0,
        "moic": 1,
        "st": "Active",
        "investType": "Direct Investment",
        "d": {
          "entity": "Spruce Capital Investments Pte. Ltd.",
          "fundingSource": "NA",
          "structure": "",
          "mgmtFeeRate": 1.35,
          "description": "Indonesian Coffeehouse Chain",
          "holdYrs": 7,
          "geo": "Southeast Asia",
          "sheet": "FORE"
        },
        "inv": {
          "legalName": "Fore Coffee",
          "entity": "Spruce Capital Investments Pte. Ltd.",
          "investType": "Direct Investment",
          "fundingSource": "NA",
          "mgmtFeeRate": 1.35,
          "prefReturnRate": 8,
          "carryRate": 10,
          "stakePct": null,
          "reportDate": "31 Mar 2026",
          "investCcy": "USD",
          "ccy": "USD",
          "description": "Indonesian Coffeehouse Chain",
          "keyRights": "",
          "txns": [
            {
              "date": "Apr 2019",
              "eom": null,
              "type": "Buy",
              "value": 0.55,
              "fx": null,
              "notes": "FORE"
            }
          ],
          "quarterly": [
            {
              "q": "Q1'26",
              "mv": 0.55,
              "cost": 0.55,
              "pps": null,
              "sharesOut": null,
              "shPct": null,
              "moic": 1,
              "xirr": null,
              "notes": "CAS"
            }
          ]
        }
      },
      {
        "n": "BUMA",
        "tp": "Equity",
        "dt": "Jul 2021",
        "cost": 36.5,
        "fmv": 36.5,
        "real": 0,
        "moic": 1,
        "st": "Active",
        "investType": "Direct Investment",
        "d": {
          "entity": "Meranti Global Investment Ltd",
          "fundingSource": "NA",
          "structure": "EPA",
          "mgmtFeeRate": 2,
          "description": "Indonesian Mining Services",
          "holdYrs": 4.7,
          "geo": "Southeast Asia",
          "sheet": "BUMA"
        },
        "inv": {
          "legalName": "BUMA",
          "entity": "Meranti Global Investment Ltd",
          "investType": "Direct Investment",
          "fundingSource": "NA",
          "mgmtFeeRate": 2,
          "prefReturnRate": 8,
          "carryRate": 10,
          "stakePct": null,
          "reportDate": "31 Mar 2026",
          "investCcy": "USD",
          "ccy": "USD",
          "description": "Indonesian Mining Services",
          "keyRights": "",
          "txns": [
            {
              "date": "Jul 2021",
              "eom": null,
              "type": "Buy",
              "value": 36.5,
              "fx": null,
              "notes": "BUMA"
            }
          ],
          "quarterly": [
            {
              "q": "Q1'26",
              "mv": 36.5,
              "cost": 36.5,
              "pps": null,
              "sharesOut": null,
              "shPct": null,
              "moic": 1,
              "xirr": null,
              "notes": "CAS"
            }
          ]
        }
      },
      {
        "n": "AirBnb",
        "tp": "Equity",
        "dt": "Dec 2018",
        "cost": 4.72,
        "fmv": 4.72,
        "real": 0,
        "moic": 1,
        "st": "Active",
        "investType": "Direct Investment",
        "d": {
          "entity": "Hawthorn Capital Investment Ltd",
          "fundingSource": "NA",
          "structure": "",
          "mgmtFeeRate": 1.35,
          "description": "Global Travel and Experiences Platform",
          "holdYrs": 7.3,
          "geo": "Southeast Asia",
          "sheet": "ABNB"
        },
        "inv": {
          "legalName": "AirBnb",
          "entity": "Hawthorn Capital Investment Ltd",
          "investType": "Direct Investment",
          "fundingSource": "NA",
          "mgmtFeeRate": 1.35,
          "prefReturnRate": 8,
          "carryRate": 10,
          "stakePct": null,
          "reportDate": "31 Mar 2026",
          "investCcy": "USD",
          "ccy": "USD",
          "description": "Global Travel and Experiences Platform",
          "keyRights": "",
          "txns": [
            {
              "date": "Dec 2018",
              "eom": null,
              "type": "Buy",
              "value": 4.72,
              "fx": null,
              "notes": "ABNB"
            }
          ],
          "quarterly": [
            {
              "q": "Q1'26",
              "mv": 4.72,
              "cost": 4.72,
              "pps": null,
              "sharesOut": null,
              "shPct": null,
              "moic": 1,
              "xirr": null,
              "notes": "CAS"
            }
          ]
        }
      },
      {
        "n": "Spotify",
        "tp": "Equity",
        "dt": "Dec 2018",
        "cost": 3,
        "fmv": 3,
        "real": 0,
        "moic": 1,
        "st": "Active",
        "investType": "Direct Investment",
        "d": {
          "entity": "Hawthorn Capital Investment Ltd",
          "fundingSource": "NA",
          "structure": "",
          "mgmtFeeRate": 1.35,
          "description": "Music and Audio Streaming Platform",
          "holdYrs": 7.3,
          "geo": "Southeast Asia",
          "sheet": "SPOT"
        },
        "inv": {
          "legalName": "Spotify",
          "entity": "Hawthorn Capital Investment Ltd",
          "investType": "Direct Investment",
          "fundingSource": "NA",
          "mgmtFeeRate": 1.35,
          "prefReturnRate": 8,
          "carryRate": 10,
          "stakePct": null,
          "reportDate": "31 Mar 2026",
          "investCcy": "USD",
          "ccy": "USD",
          "description": "Music and Audio Streaming Platform",
          "keyRights": "",
          "txns": [
            {
              "date": "Dec 2018",
              "eom": null,
              "type": "Buy",
              "value": 3,
              "fx": null,
              "notes": "SPOT"
            }
          ],
          "quarterly": [
            {
              "q": "Q1'26",
              "mv": 3,
              "cost": 3,
              "pps": null,
              "sharesOut": null,
              "shPct": null,
              "moic": 1,
              "xirr": null,
              "notes": "CAS"
            }
          ]
        }
      },
      {
        "n": "6Estates",
        "tp": "Equity",
        "dt": "Jul 2021",
        "cost": 5,
        "fmv": 5,
        "real": 0,
        "moic": 1,
        "st": "Active",
        "investType": "Direct Investment",
        "d": {
          "entity": "Big Rainbow Investment Pte Ltd",
          "fundingSource": "PT Sinar Mas Multiartha Tbk",
          "structure": "",
          "mgmtFeeRate": 1.35,
          "description": "Enterprise AI Document Processing",
          "holdYrs": 4.7,
          "geo": "Southeast Asia",
          "sheet": "6EST"
        },
        "inv": {
          "legalName": "6Estates",
          "entity": "Big Rainbow Investment Pte Ltd",
          "investType": "Direct Investment",
          "fundingSource": "PT Sinar Mas Multiartha Tbk",
          "mgmtFeeRate": 1.35,
          "prefReturnRate": 8,
          "carryRate": 10,
          "stakePct": null,
          "reportDate": "31 Mar 2026",
          "investCcy": "USD",
          "ccy": "USD",
          "description": "Enterprise AI Document Processing",
          "keyRights": "",
          "txns": [
            {
              "date": "Jul 2021",
              "eom": null,
              "type": "Buy",
              "value": 5,
              "fx": null,
              "notes": "6EST"
            }
          ],
          "quarterly": [
            {
              "q": "Q1'26",
              "mv": 5,
              "cost": 5,
              "pps": null,
              "sharesOut": null,
              "shPct": null,
              "moic": 1,
              "xirr": null,
              "notes": "CAS"
            }
          ]
        }
      },
      {
        "n": "Gushcloud",
        "tp": "Equity",
        "dt": "Feb 2021",
        "cost": 1,
        "fmv": 1,
        "real": 0,
        "moic": 1,
        "st": "Active",
        "investType": "Direct Investment",
        "d": {
          "entity": "Meranti Global Investment Ltd",
          "fundingSource": "PT Sinar Mas Multiartha Tbk",
          "structure": "EPA",
          "mgmtFeeRate": 0.25,
          "description": "Entertainment and Talent Company",
          "holdYrs": 5.2,
          "geo": "Southeast Asia",
          "sheet": "GUSH"
        },
        "inv": {
          "legalName": "Gushcloud",
          "entity": "Meranti Global Investment Ltd",
          "investType": "Direct Investment",
          "fundingSource": "PT Sinar Mas Multiartha Tbk",
          "mgmtFeeRate": 0.25,
          "prefReturnRate": 8,
          "carryRate": 10,
          "stakePct": null,
          "reportDate": "31 Mar 2026",
          "investCcy": "USD",
          "ccy": "USD",
          "description": "Entertainment and Talent Company",
          "keyRights": "",
          "txns": [
            {
              "date": "Feb 2021",
              "eom": null,
              "type": "Buy",
              "value": 1,
              "fx": null,
              "notes": "GUSH"
            }
          ],
          "quarterly": [
            {
              "q": "Q1'26",
              "mv": 1,
              "cost": 1,
              "pps": null,
              "sharesOut": null,
              "shPct": null,
              "moic": 1,
              "xirr": null,
              "notes": "CAS"
            }
          ]
        }
      },
      {
        "n": "Dana",
        "tp": "Equity",
        "dt": "Apr 2022",
        "cost": 25,
        "fmv": 25,
        "real": 0,
        "moic": 1,
        "st": "Active",
        "investType": "Direct Investment",
        "d": {
          "entity": "PT Sinar Mas Multiartha Tbk",
          "fundingSource": "PT Sinar Mas Multiartha Tbk",
          "structure": "",
          "mgmtFeeRate": 1.35,
          "description": "Indonesian Digital Payment Wallet",
          "holdYrs": 4,
          "geo": "Southeast Asia",
          "sheet": "DANA"
        },
        "inv": {
          "legalName": "Dana",
          "entity": "PT Sinar Mas Multiartha Tbk",
          "investType": "Direct Investment",
          "fundingSource": "PT Sinar Mas Multiartha Tbk",
          "mgmtFeeRate": 1.35,
          "prefReturnRate": 8,
          "carryRate": 10,
          "stakePct": null,
          "reportDate": "31 Mar 2026",
          "investCcy": "USD",
          "ccy": "USD",
          "description": "Indonesian Digital Payment Wallet",
          "keyRights": "",
          "txns": [
            {
              "date": "Apr 2022",
              "eom": null,
              "type": "Buy",
              "value": 25,
              "fx": null,
              "notes": "DANA"
            }
          ],
          "quarterly": [
            {
              "q": "Q1'26",
              "mv": 25,
              "cost": 25,
              "pps": null,
              "sharesOut": null,
              "shPct": null,
              "moic": 1,
              "xirr": null,
              "notes": "CAS"
            }
          ]
        }
      },
      {
        "n": "Agate",
        "tp": "Equity",
        "dt": "Dec 2020",
        "cost": 2.05,
        "fmv": 2.05,
        "real": 0,
        "moic": 1,
        "st": "Active",
        "investType": "Direct Investment",
        "d": {
          "entity": "PT Sinarmas Ventura & PT Akselerasi Digital Inovasi",
          "fundingSource": "PT Sinar Mas Multiartha Tbk",
          "structure": "",
          "mgmtFeeRate": 1.35,
          "description": "Indonesian Full-cycle Game Developer",
          "holdYrs": 5.3,
          "geo": "Southeast Asia",
          "sheet": "AGAT"
        },
        "inv": {
          "legalName": "Agate",
          "entity": "PT Sinarmas Ventura & PT Akselerasi Digital Inovasi",
          "investType": "Direct Investment",
          "fundingSource": "PT Sinar Mas Multiartha Tbk",
          "mgmtFeeRate": 1.35,
          "prefReturnRate": 8,
          "carryRate": 10,
          "stakePct": null,
          "reportDate": "31 Mar 2026",
          "investCcy": "USD",
          "ccy": "USD",
          "description": "Indonesian Full-cycle Game Developer",
          "keyRights": "",
          "txns": [
            {
              "date": "Dec 2020",
              "eom": null,
              "type": "Buy",
              "value": 2.05,
              "fx": null,
              "notes": "AGAT"
            }
          ],
          "quarterly": [
            {
              "q": "Q1'26",
              "mv": 2.05,
              "cost": 2.05,
              "pps": null,
              "sharesOut": null,
              "shPct": null,
              "moic": 1,
              "xirr": null,
              "notes": "CAS"
            }
          ]
        }
      }
    ]
  },
  {
    "id": "2",
    "n": "Fund of Funds",
    "v": 2016,
    "size": 194.6,
    "called": 118.77,
    "calledPct": 61,
    "fmv": 118.77,
    "real": 0,
    "dpi": 0,
    "tvpi": 1,
    "irr": 9.8,
    "st": "Investing",
    "hist": {
      "committed": [
        184.87,
        188.76,
        192.65,
        194.6
      ],
      "called": [
        109.27,
        112.83,
        116.39,
        118.77
      ],
      "fmv": [
        111.64,
        114.02,
        116.39,
        118.77
      ]
    },
    "h": [
      {
        "n": "Indies Special Opportunity Fund II",
        "tp": "Fund of funds",
        "dt": "May 2018",
        "cost": 4.4,
        "fmv": 4.4,
        "real": 0,
        "moic": 1,
        "st": "Active",
        "investType": "Fund of Funds",
        "d": {
          "targetFund": "Indies Special Opportunity Fund II",
          "commit": 5,
          "calledFoF": 4.4,
          "nav": 4.4,
          "entity": "Asia Star Fund Ltd",
          "fundingSource": "PT Aldiracita Sekuritas Indonesia",
          "structure": "",
          "sheet": "ISOII"
        },
        "inv": {
          "legalName": "Indies Special Opportunity Fund II",
          "entity": "Asia Star Fund Ltd",
          "investType": "Fund of Funds",
          "fundingSource": "PT Aldiracita Sekuritas Indonesia",
          "mgmtFeeRate": 1.35,
          "prefReturnRate": 8,
          "carryRate": 10,
          "stakePct": null,
          "reportDate": "31 Mar 2026",
          "investCcy": "USD",
          "ccy": "USD",
          "description": "",
          "keyRights": "",
          "txns": [
            {
              "date": "May 2018",
              "eom": null,
              "type": "Buy",
              "value": 4.4,
              "fx": null,
              "notes": "ISOII"
            }
          ],
          "quarterly": [
            {
              "q": "Q1'26",
              "mv": 4.4,
              "cost": 4.4,
              "sharesOut": null,
              "shPct": null,
              "moic": 1,
              "xirr": null,
              "notes": "CAS"
            }
          ]
        }
      },
      {
        "n": "Sylvan Capital",
        "tp": "Fund of funds",
        "dt": "Aug 2021",
        "cost": 4.46,
        "fmv": 4.46,
        "real": 0,
        "moic": 1,
        "st": "Active",
        "investType": "Fund of Funds",
        "d": {
          "targetFund": "Sylvan Capital",
          "commit": 5,
          "calledFoF": 4.46,
          "nav": 4.46,
          "entity": "Meranti Global Investment Ltd",
          "fundingSource": "DCA",
          "structure": "EPA",
          "sheet": "SYLV"
        },
        "inv": {
          "legalName": "Sylvan Capital",
          "entity": "Meranti Global Investment Ltd",
          "investType": "Fund of Funds",
          "fundingSource": "DCA",
          "mgmtFeeRate": 2,
          "prefReturnRate": 8,
          "carryRate": 10,
          "stakePct": null,
          "reportDate": "31 Mar 2026",
          "investCcy": "USD",
          "ccy": "USD",
          "description": "",
          "keyRights": "",
          "txns": [
            {
              "date": "Aug 2021",
              "eom": null,
              "type": "Buy",
              "value": 4.46,
              "fx": null,
              "notes": "SYLV"
            }
          ],
          "quarterly": [
            {
              "q": "Q1'26",
              "mv": 4.46,
              "cost": 4.46,
              "sharesOut": null,
              "shPct": null,
              "moic": 1,
              "xirr": null,
              "notes": "CAS"
            }
          ]
        }
      },
      {
        "n": "1982 Fund I",
        "tp": "Fund of funds",
        "dt": "Dec 2021",
        "cost": 2,
        "fmv": 2,
        "real": 0,
        "moic": 1,
        "st": "Active",
        "investType": "Fund of Funds",
        "d": {
          "targetFund": "1982 Fund I",
          "commit": 2,
          "calledFoF": 2,
          "nav": 2,
          "entity": "Startech Growth Fund VCC",
          "fundingSource": "NIC",
          "structure": "Mgmt Fee",
          "sheet": "1982"
        },
        "inv": {
          "legalName": "1982 Fund I",
          "entity": "Startech Growth Fund VCC",
          "investType": "Fund of Funds",
          "fundingSource": "NIC",
          "mgmtFeeRate": 1.35,
          "prefReturnRate": 8,
          "carryRate": 10,
          "stakePct": null,
          "reportDate": "31 Mar 2026",
          "investCcy": "USD",
          "ccy": "USD",
          "description": "",
          "keyRights": "",
          "txns": [
            {
              "date": "Dec 2021",
              "eom": null,
              "type": "Buy",
              "value": 2,
              "fx": null,
              "notes": "1982"
            }
          ],
          "quarterly": [
            {
              "q": "Q1'26",
              "mv": 2,
              "cost": 2,
              "sharesOut": null,
              "shPct": null,
              "moic": 1,
              "xirr": null,
              "notes": "CAS"
            }
          ]
        }
      },
      {
        "n": "Tanglin Ventures Fund II",
        "tp": "Fund of funds",
        "dt": "Sep 2022",
        "cost": 1.4,
        "fmv": 1.4,
        "real": 0,
        "moic": 1,
        "st": "Active",
        "investType": "Fund of Funds",
        "d": {
          "targetFund": "Tanglin Ventures Fund II",
          "commit": 2,
          "calledFoF": 1.4,
          "nav": 1.4,
          "entity": "Startech Growth Fund VCC",
          "fundingSource": "NIC",
          "structure": "Mgmt Fee",
          "sheet": "TANG"
        },
        "inv": {
          "legalName": "Tanglin Ventures Fund II",
          "entity": "Startech Growth Fund VCC",
          "investType": "Fund of Funds",
          "fundingSource": "NIC",
          "mgmtFeeRate": 1.35,
          "prefReturnRate": 8,
          "carryRate": 10,
          "stakePct": null,
          "reportDate": "31 Mar 2026",
          "investCcy": "USD",
          "ccy": "USD",
          "description": "",
          "keyRights": "",
          "txns": [
            {
              "date": "Sep 2022",
              "eom": null,
              "type": "Buy",
              "value": 1.4,
              "fx": null,
              "notes": "TANG"
            }
          ],
          "quarterly": [
            {
              "q": "Q1'26",
              "mv": 1.4,
              "cost": 1.4,
              "sharesOut": null,
              "shPct": null,
              "moic": 1,
              "xirr": null,
              "notes": "CAS"
            }
          ]
        }
      },
      {
        "n": "AC Ventures Fund V",
        "tp": "Fund of funds",
        "dt": "Nov 2022",
        "cost": 1.02,
        "fmv": 1.02,
        "real": 0,
        "moic": 1,
        "st": "Active",
        "investType": "Fund of Funds",
        "d": {
          "targetFund": "AC Ventures Fund V",
          "commit": 2,
          "calledFoF": 1.02,
          "nav": 1.02,
          "entity": "Startech Growth Fund VCC",
          "fundingSource": "NIC",
          "structure": "Mgmt Fee",
          "sheet": "ACVV"
        },
        "inv": {
          "legalName": "AC Ventures Fund V",
          "entity": "Startech Growth Fund VCC",
          "investType": "Fund of Funds",
          "fundingSource": "NIC",
          "mgmtFeeRate": 1.35,
          "prefReturnRate": 8,
          "carryRate": 10,
          "stakePct": null,
          "reportDate": "31 Mar 2026",
          "investCcy": "USD",
          "ccy": "USD",
          "description": "",
          "keyRights": "",
          "txns": [
            {
              "date": "Nov 2022",
              "eom": null,
              "type": "Buy",
              "value": 1.02,
              "fx": null,
              "notes": "ACVV"
            }
          ],
          "quarterly": [
            {
              "q": "Q1'26",
              "mv": 1.02,
              "cost": 1.02,
              "sharesOut": null,
              "shPct": null,
              "moic": 1,
              "xirr": null,
              "notes": "CAS"
            }
          ]
        }
      },
      {
        "n": "Fortwest",
        "tp": "Fund of funds",
        "dt": "Apr 2025",
        "cost": 0.4,
        "fmv": 0.4,
        "real": 0,
        "moic": 1,
        "st": "Active",
        "investType": "Fund of Funds",
        "d": {
          "targetFund": "Fortwest",
          "commit": 1,
          "calledFoF": 0.4,
          "nav": 0.4,
          "entity": "Startech Growth Fund VCC",
          "fundingSource": "NIC",
          "structure": "Mgmt Fee",
          "sheet": "FORT"
        },
        "inv": {
          "legalName": "Fortwest",
          "entity": "Startech Growth Fund VCC",
          "investType": "Fund of Funds",
          "fundingSource": "NIC",
          "mgmtFeeRate": 1.35,
          "prefReturnRate": 8,
          "carryRate": 10,
          "stakePct": null,
          "reportDate": "31 Mar 2026",
          "investCcy": "USD",
          "ccy": "USD",
          "description": "",
          "keyRights": "",
          "txns": [
            {
              "date": "Apr 2025",
              "eom": null,
              "type": "Buy",
              "value": 0.4,
              "fx": null,
              "notes": "FORT"
            }
          ],
          "quarterly": [
            {
              "q": "Q1'26",
              "mv": 0.4,
              "cost": 0.4,
              "sharesOut": null,
              "shPct": null,
              "moic": 1,
              "xirr": null,
              "notes": "CAS"
            }
          ]
        }
      },
      {
        "n": "Gan Samudera (GSL)",
        "tp": "Fund of funds",
        "dt": "Sep 2021",
        "cost": 0.38,
        "fmv": 0.38,
        "real": 0,
        "moic": 1,
        "st": "Active",
        "investType": "Fund of Funds",
        "d": {
          "targetFund": "Gan Samudera (GSL)",
          "commit": 0.4,
          "calledFoF": 0.38,
          "nav": 0.38,
          "entity": "Walker Strategic Investments Inc",
          "fundingSource": "NA",
          "structure": "",
          "sheet": "GANS"
        },
        "inv": {
          "legalName": "Gan Samudera (GSL)",
          "entity": "Walker Strategic Investments Inc",
          "investType": "Fund of Funds",
          "fundingSource": "NA",
          "mgmtFeeRate": 1.35,
          "prefReturnRate": 8,
          "carryRate": 10,
          "stakePct": null,
          "reportDate": "31 Mar 2026",
          "investCcy": "USD",
          "ccy": "USD",
          "description": "",
          "keyRights": "",
          "txns": [
            {
              "date": "Sep 2021",
              "eom": null,
              "type": "Buy",
              "value": 0.38,
              "fx": null,
              "notes": "GANS"
            }
          ],
          "quarterly": [
            {
              "q": "Q1'26",
              "mv": 0.38,
              "cost": 0.38,
              "sharesOut": null,
              "shPct": null,
              "moic": 1,
              "xirr": null,
              "notes": "CAS"
            }
          ]
        }
      },
      {
        "n": "Indies Strategic Tech Fund I",
        "tp": "Fund of funds",
        "dt": "Dec 2019",
        "cost": 3.38,
        "fmv": 3.38,
        "real": 0,
        "moic": 1,
        "st": "Active",
        "investType": "Fund of Funds",
        "d": {
          "targetFund": "Indies Strategic Tech Fund I",
          "commit": 3.4,
          "calledFoF": 3.38,
          "nav": 3.38,
          "entity": "Hawthorn Limited",
          "fundingSource": "NA",
          "structure": "",
          "sheet": "ISTFI"
        },
        "inv": {
          "legalName": "Indies Strategic Tech Fund I",
          "entity": "Hawthorn Limited",
          "investType": "Fund of Funds",
          "fundingSource": "NA",
          "mgmtFeeRate": 1.35,
          "prefReturnRate": 8,
          "carryRate": 10,
          "stakePct": null,
          "reportDate": "31 Mar 2026",
          "investCcy": "USD",
          "ccy": "USD",
          "description": "",
          "keyRights": "",
          "txns": [
            {
              "date": "Dec 2019",
              "eom": null,
              "type": "Buy",
              "value": 3.38,
              "fx": null,
              "notes": "ISTFI"
            }
          ],
          "quarterly": [
            {
              "q": "Q1'26",
              "mv": 3.38,
              "cost": 3.38,
              "sharesOut": null,
              "shPct": null,
              "moic": 1,
              "xirr": null,
              "notes": "CAS"
            }
          ]
        }
      },
      {
        "n": "IdeoSource",
        "tp": "Fund of funds",
        "dt": "Dec 2017",
        "cost": 2,
        "fmv": 2,
        "real": 0,
        "moic": 1,
        "st": "Active",
        "investType": "Fund of Funds",
        "d": {
          "targetFund": "IdeoSource",
          "commit": 2,
          "calledFoF": 2,
          "nav": 2,
          "entity": "NA",
          "fundingSource": "NA",
          "structure": "",
          "sheet": "IDEO"
        },
        "inv": {
          "legalName": "IdeoSource",
          "entity": "NA",
          "investType": "Fund of Funds",
          "fundingSource": "NA",
          "mgmtFeeRate": 1.35,
          "prefReturnRate": 8,
          "carryRate": 10,
          "stakePct": null,
          "reportDate": "31 Mar 2026",
          "investCcy": "USD",
          "ccy": "USD",
          "description": "",
          "keyRights": "",
          "txns": [
            {
              "date": "Dec 2017",
              "eom": null,
              "type": "Buy",
              "value": 2,
              "fx": null,
              "notes": "IDEO"
            }
          ],
          "quarterly": [
            {
              "q": "Q1'26",
              "mv": 2,
              "cost": 2,
              "sharesOut": null,
              "shPct": null,
              "moic": 1,
              "xirr": null,
              "notes": "CAS"
            }
          ]
        }
      },
      {
        "n": "Jarvis Fund I",
        "tp": "Fund of funds",
        "dt": "Aug 2021",
        "cost": 0.69,
        "fmv": 0.69,
        "real": 0,
        "moic": 1,
        "st": "Active",
        "investType": "Fund of Funds",
        "d": {
          "targetFund": "Jarvis Fund I",
          "commit": 0.7,
          "calledFoF": 0.69,
          "nav": 0.69,
          "entity": "PT SKS",
          "fundingSource": "NA",
          "structure": "",
          "sheet": "JARVI"
        },
        "inv": {
          "legalName": "Jarvis Fund I",
          "entity": "PT SKS",
          "investType": "Fund of Funds",
          "fundingSource": "NA",
          "mgmtFeeRate": 1.35,
          "prefReturnRate": 8,
          "carryRate": 10,
          "stakePct": null,
          "reportDate": "31 Mar 2026",
          "investCcy": "USD",
          "ccy": "USD",
          "description": "",
          "keyRights": "",
          "txns": [
            {
              "date": "Aug 2021",
              "eom": null,
              "type": "Buy",
              "value": 0.69,
              "fx": null,
              "notes": "JARVI"
            }
          ],
          "quarterly": [
            {
              "q": "Q1'26",
              "mv": 0.69,
              "cost": 0.69,
              "sharesOut": null,
              "shPct": null,
              "moic": 1,
              "xirr": null,
              "notes": "CAS"
            }
          ]
        }
      },
      {
        "n": "Jarvis Fund II",
        "tp": "Fund of funds",
        "dt": "Aug 2021",
        "cost": 1.15,
        "fmv": 1.15,
        "real": 0,
        "moic": 1,
        "st": "Active",
        "investType": "Fund of Funds",
        "d": {
          "targetFund": "Jarvis Fund II",
          "commit": 1.1,
          "calledFoF": 1.15,
          "nav": 1.15,
          "entity": "PT SKS",
          "fundingSource": "NA",
          "structure": "",
          "sheet": "JARVII"
        },
        "inv": {
          "legalName": "Jarvis Fund II",
          "entity": "PT SKS",
          "investType": "Fund of Funds",
          "fundingSource": "NA",
          "mgmtFeeRate": 1.35,
          "prefReturnRate": 8,
          "carryRate": 10,
          "stakePct": null,
          "reportDate": "31 Mar 2026",
          "investCcy": "USD",
          "ccy": "USD",
          "description": "",
          "keyRights": "",
          "txns": [
            {
              "date": "Aug 2021",
              "eom": null,
              "type": "Buy",
              "value": 1.15,
              "fx": null,
              "notes": "JARVII"
            }
          ],
          "quarterly": [
            {
              "q": "Q1'26",
              "mv": 1.15,
              "cost": 1.15,
              "sharesOut": null,
              "shPct": null,
              "moic": 1,
              "xirr": null,
              "notes": "CAS"
            }
          ]
        }
      },
      {
        "n": "Indies Strategic Tech Fund II",
        "tp": "Fund of funds",
        "dt": "Aug 2021",
        "cost": 1.68,
        "fmv": 1.68,
        "real": 0,
        "moic": 1,
        "st": "Active",
        "investType": "Fund of Funds",
        "d": {
          "targetFund": "Indies Strategic Tech Fund II",
          "commit": 2,
          "calledFoF": 1.68,
          "nav": 1.68,
          "entity": "Meranti Global Investment Ltd",
          "fundingSource": "PT Sinar Mas Multiartha Tbk",
          "structure": "EPA",
          "sheet": "ISTFII"
        },
        "inv": {
          "legalName": "Indies Strategic Tech Fund II",
          "entity": "Meranti Global Investment Ltd",
          "investType": "Fund of Funds",
          "fundingSource": "PT Sinar Mas Multiartha Tbk",
          "mgmtFeeRate": 0.25,
          "prefReturnRate": 8,
          "carryRate": 10,
          "stakePct": null,
          "reportDate": "31 Mar 2026",
          "investCcy": "USD",
          "ccy": "USD",
          "description": "",
          "keyRights": "",
          "txns": [
            {
              "date": "Aug 2021",
              "eom": null,
              "type": "Buy",
              "value": 1.68,
              "fx": null,
              "notes": "ISTFII"
            }
          ],
          "quarterly": [
            {
              "q": "Q1'26",
              "mv": 1.68,
              "cost": 1.68,
              "sharesOut": null,
              "shPct": null,
              "moic": 1,
              "xirr": null,
              "notes": "CAS"
            }
          ]
        }
      },
      {
        "n": "Adivira Fund I",
        "tp": "Fund of funds",
        "dt": "Jul 2022",
        "cost": 78.29,
        "fmv": 78.29,
        "real": 0,
        "moic": 1,
        "st": "Active",
        "investType": "Fund of Funds",
        "d": {
          "targetFund": "Adivira Fund I",
          "commit": 148,
          "calledFoF": 78.29,
          "nav": 78.29,
          "entity": "Meranti SG, Chestnut Avenue",
          "fundingSource": "PT Sinar Mas Multiartha Tbk",
          "structure": "",
          "sheet": "ADVR"
        },
        "inv": {
          "legalName": "Adivira Fund I",
          "entity": "Meranti SG, Chestnut Avenue",
          "investType": "Fund of Funds",
          "fundingSource": "PT Sinar Mas Multiartha Tbk",
          "mgmtFeeRate": 1.35,
          "prefReturnRate": 8,
          "carryRate": 10,
          "stakePct": null,
          "reportDate": "31 Mar 2026",
          "investCcy": "USD",
          "ccy": "USD",
          "description": "",
          "keyRights": "",
          "txns": [
            {
              "date": "Jul 2022",
              "eom": null,
              "type": "Buy",
              "value": 78.29,
              "fx": null,
              "notes": "ADVR"
            }
          ],
          "quarterly": [
            {
              "q": "Q1'26",
              "mv": 78.29,
              "cost": 78.29,
              "sharesOut": null,
              "shPct": null,
              "moic": 1,
              "xirr": null,
              "notes": "CAS"
            }
          ]
        }
      },
      {
        "n": "01 Fintech",
        "tp": "Fund of funds",
        "dt": "Dec 2023",
        "cost": 3.02,
        "fmv": 3.02,
        "real": 0,
        "moic": 1,
        "st": "Active",
        "investType": "Fund of Funds",
        "d": {
          "targetFund": "01 Fintech",
          "commit": 5,
          "calledFoF": 3.02,
          "nav": 3.02,
          "entity": "PT Sinar Mas Multiartha Tbk",
          "fundingSource": "PT Sinar Mas Multiartha Tbk",
          "structure": "",
          "sheet": "01FN"
        },
        "inv": {
          "legalName": "01 Fintech",
          "entity": "PT Sinar Mas Multiartha Tbk",
          "investType": "Fund of Funds",
          "fundingSource": "PT Sinar Mas Multiartha Tbk",
          "mgmtFeeRate": 1.35,
          "prefReturnRate": 8,
          "carryRate": 10,
          "stakePct": null,
          "reportDate": "31 Mar 2026",
          "investCcy": "USD",
          "ccy": "USD",
          "description": "",
          "keyRights": "",
          "txns": [
            {
              "date": "Dec 2023",
              "eom": null,
              "type": "Buy",
              "value": 3.02,
              "fx": null,
              "notes": "01FN"
            }
          ],
          "quarterly": [
            {
              "q": "Q1'26",
              "mv": 3.02,
              "cost": 3.02,
              "sharesOut": null,
              "shPct": null,
              "moic": 1,
              "xirr": null,
              "notes": "CAS"
            }
          ]
        }
      },
      {
        "n": "Alpha JWC Fund I",
        "tp": "Fund of funds",
        "dt": "May 2016",
        "cost": 5,
        "fmv": 5,
        "real": 0,
        "moic": 1,
        "st": "Active",
        "investType": "Fund of Funds",
        "d": {
          "targetFund": "Alpha JWC Fund I",
          "commit": 5,
          "calledFoF": 5,
          "nav": 5,
          "entity": "PT Sinar Mas Multiartha Tbk",
          "fundingSource": "PT Sinar Mas Multiartha Tbk",
          "structure": "",
          "sheet": "AJWCI"
        },
        "inv": {
          "legalName": "Alpha JWC Fund I",
          "entity": "PT Sinar Mas Multiartha Tbk",
          "investType": "Fund of Funds",
          "fundingSource": "PT Sinar Mas Multiartha Tbk",
          "mgmtFeeRate": 1.35,
          "prefReturnRate": 8,
          "carryRate": 10,
          "stakePct": null,
          "reportDate": "31 Mar 2026",
          "investCcy": "USD",
          "ccy": "USD",
          "description": "",
          "keyRights": "",
          "txns": [
            {
              "date": "May 2016",
              "eom": null,
              "type": "Buy",
              "value": 5,
              "fx": null,
              "notes": "AJWCI"
            }
          ],
          "quarterly": [
            {
              "q": "Q1'26",
              "mv": 5,
              "cost": 5,
              "sharesOut": null,
              "shPct": null,
              "moic": 1,
              "xirr": null,
              "notes": "CAS"
            }
          ]
        }
      },
      {
        "n": "Alpha JWC Fund II",
        "tp": "Fund of funds",
        "dt": "Aug 2018",
        "cost": 4.9,
        "fmv": 4.9,
        "real": 0,
        "moic": 1,
        "st": "Active",
        "investType": "Fund of Funds",
        "d": {
          "targetFund": "Alpha JWC Fund II",
          "commit": 5,
          "calledFoF": 4.9,
          "nav": 4.9,
          "entity": "PT Sinar Mas Multiartha Tbk",
          "fundingSource": "PT Sinar Mas Multiartha Tbk",
          "structure": "",
          "sheet": "AJWCII"
        },
        "inv": {
          "legalName": "Alpha JWC Fund II",
          "entity": "PT Sinar Mas Multiartha Tbk",
          "investType": "Fund of Funds",
          "fundingSource": "PT Sinar Mas Multiartha Tbk",
          "mgmtFeeRate": 1.35,
          "prefReturnRate": 8,
          "carryRate": 10,
          "stakePct": null,
          "reportDate": "31 Mar 2026",
          "investCcy": "USD",
          "ccy": "USD",
          "description": "",
          "keyRights": "",
          "txns": [
            {
              "date": "Aug 2018",
              "eom": null,
              "type": "Buy",
              "value": 4.9,
              "fx": null,
              "notes": "AJWCII"
            }
          ],
          "quarterly": [
            {
              "q": "Q1'26",
              "mv": 4.9,
              "cost": 4.9,
              "sharesOut": null,
              "shPct": null,
              "moic": 1,
              "xirr": null,
              "notes": "CAS"
            }
          ]
        }
      },
      {
        "n": "Alpha JWC Fund III",
        "tp": "Fund of funds",
        "dt": "Sep 2021",
        "cost": 4.6,
        "fmv": 4.6,
        "real": 0,
        "moic": 1,
        "st": "Active",
        "investType": "Fund of Funds",
        "d": {
          "targetFund": "Alpha JWC Fund III",
          "commit": 5,
          "calledFoF": 4.6,
          "nav": 4.6,
          "entity": "PT Sinar Mas Multiartha Tbk",
          "fundingSource": "PT Sinar Mas Multiartha Tbk",
          "structure": "",
          "sheet": "AJWCIII"
        },
        "inv": {
          "legalName": "Alpha JWC Fund III",
          "entity": "PT Sinar Mas Multiartha Tbk",
          "investType": "Fund of Funds",
          "fundingSource": "PT Sinar Mas Multiartha Tbk",
          "mgmtFeeRate": 1.35,
          "prefReturnRate": 8,
          "carryRate": 10,
          "stakePct": null,
          "reportDate": "31 Mar 2026",
          "investCcy": "USD",
          "ccy": "USD",
          "description": "",
          "keyRights": "",
          "txns": [
            {
              "date": "Sep 2021",
              "eom": null,
              "type": "Buy",
              "value": 4.6,
              "fx": null,
              "notes": "AJWCIII"
            }
          ],
          "quarterly": [
            {
              "q": "Q1'26",
              "mv": 4.6,
              "cost": 4.6,
              "sharesOut": null,
              "shPct": null,
              "moic": 1,
              "xirr": null,
              "notes": "CAS"
            }
          ]
        }
      }
    ]
  }
];

export const SEED_INVESTORS: Investor[] = [
  {
    "id": "i1",
    "n": "PT Sinar Mas Multiartha Tbk",
    "type": "Corporate",
    "stakes": {
      "1": 0.45,
      "2": 0.55
    }
  },
  {
    "id": "i2",
    "n": "DCA / NIC Programs",
    "type": "Internal",
    "stakes": {
      "1": 0.35,
      "2": 0.25
    }
  },
  {
    "id": "i3",
    "n": "Co-invest Partners",
    "type": "Co-invest",
    "stakes": {
      "1": 0.2,
      "2": 0.2
    }
  }
];
