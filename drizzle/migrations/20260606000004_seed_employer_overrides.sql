-- Resolution overrides (name + internal flag).
INSERT INTO employer_overrides (domain, employer_name, internal) VALUES
  ('starcapital.co.id',       'STAR Capital Group',                 true),
  ('starcapitalholdings.com', 'STAR Capital Holdings',              true),
  ('aldiracita.com',          'Aldiracita',                         true),
  ('adivira.com',             'Adivira',                            true),
  ('lifewithsun.com',         'Life With Sun',                      true),
  ('lw.com',                  'Latham & Watkins',                   false),
  ('samsung.com',             'Samsung',                            false),
  ('hosanco.com',             'Hosanco',                            false),
  ('parthenon.ey.com',        'EY-Parthenon',                       false),
  ('ey.com',                  'EY',                                 false),
  ('cset.ac.cn',              'CSET',                               false),
  ('hanafn.com',              'Hana Financial Group',               false),
  ('aon.com',                 'Aon',                                false),
  ('techconnect.co.id',       'TechConnect',                        false),
  ('indiescp.com',            'IndiesCP',                           false),
  ('faralloncapital.com',     'Farallon Capital',                   false),
  ('frontiergroup.sg',        'Frontier Group',                     false),
  ('ramboll.com',             'Ramboll',                            false),
  ('morganstanley.com',       'Morgan Stanley',                     false),
  ('beraucoal.co.id',         'Berau Coal',                         false),
  ('blueowl.com',             'Blue Owl Capital',                   false),
  ('theolivelink.com',        'Olive Link',                         false),
  ('nira.co.id',              'Nira',                               false),
  ('meritz.co.kr',            'Meritz Financial',                   false),
  ('sinarmasland.com',        'Sinar Mas Land',                     false),
  ('sinarmasmining.com',      'Sinar Mas Mining',                   false),
  ('iif.co.id',               'Indonesia Infrastructure Finance',   false)
ON CONFLICT (domain) DO NOTHING;

-- Excluded domains (dropped from ingest; no employer).
INSERT INTO employer_overrides (domain, excluded) VALUES
  ('fireflies.ai',          true),
  ('fireflies.io',          true),
  ('gmail.com',             true),
  ('isupportworldwide.com', true),
  ('gbo-awards.com',        true),
  ('notice.microsoft.com',  true),
  ('yahoo.com',             true)
ON CONFLICT (domain) DO NOTHING;
