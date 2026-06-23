'use strict';
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const TAXA = 1201.52;
const pyg = brl => Math.round(brl * TAXA);

const norm = s => s.toLowerCase().normalize('NFD').replace(/\p{Mn}/gu, '').trim();

// ── Todos os ingredientes / insumos / bebidas / embalagens ─────────────────────
const INGREDIENTES = [
  // MASSAS
  { sku: 'MAS001', nome: 'Massa Broto',           categoria: 'INGREDIENTE', unidade: 'un',     precoUnitario: pyg(2.20)  },
  { sku: 'MAS002', nome: 'Massa Média',            categoria: 'INGREDIENTE', unidade: 'un',     precoUnitario: pyg(2.80)  },
  { sku: 'MAS003', nome: 'Massa Grande',           categoria: 'INGREDIENTE', unidade: 'un',     precoUnitario: pyg(3.40)  },
  { sku: 'MAS004', nome: 'Massa Família',          categoria: 'INGREDIENTE', unidade: 'un',     precoUnitario: pyg(4.50)  },
  { sku: 'MAS005', nome: 'Massa Doce',             categoria: 'INGREDIENTE', unidade: 'un',     precoUnitario: pyg(3.60)  },
  // MOLHOS
  { sku: 'MOL001', nome: 'Molho de Tomate Tradicional', categoria: 'INGREDIENTE', unidade: 'kg', precoUnitario: pyg(10.90) },
  { sku: 'MOL002', nome: 'Molho Especial da Casa',      categoria: 'INGREDIENTE', unidade: 'kg', precoUnitario: pyg(14.90) },
  { sku: 'MOL003', nome: 'Barbecue',                    categoria: 'INGREDIENTE', unidade: 'kg', precoUnitario: pyg(19.90) },
  { sku: 'MOL004', nome: 'Molho Rose',                  categoria: 'INGREDIENTE', unidade: 'kg', precoUnitario: pyg(18.90) },
  { sku: 'MOL005', nome: 'Molho de Alho',               categoria: 'INGREDIENTE', unidade: 'kg', precoUnitario: pyg(18.90) },
  { sku: 'MOL006', nome: 'Maionese Especial',           categoria: 'INGREDIENTE', unidade: 'kg', precoUnitario: pyg(17.90) },
  { sku: 'MOL007', nome: 'Ketchup',                     categoria: 'INGREDIENTE', unidade: 'kg', precoUnitario: pyg(15.90) },
  { sku: 'MOL008', nome: 'Mostarda',                    categoria: 'INGREDIENTE', unidade: 'kg', precoUnitario: pyg(15.90) },
  { sku: 'MOL009', nome: 'Molho Picante',               categoria: 'INGREDIENTE', unidade: 'kg', precoUnitario: pyg(21.90) },
  // QUEIJOS
  { sku: 'QUE001', nome: 'Mozzarella',                  categoria: 'INGREDIENTE', unidade: 'kg', precoUnitario: pyg(39.90) },
  { sku: 'QUE002', nome: 'Catupiry / Requeijão Cremoso',categoria: 'INGREDIENTE', unidade: 'kg', precoUnitario: pyg(36.90) },
  { sku: 'QUE003', nome: 'Cheddar Cremoso',             categoria: 'INGREDIENTE', unidade: 'kg', precoUnitario: pyg(31.90) },
  { sku: 'QUE004', nome: 'Parmesão',                    categoria: 'INGREDIENTE', unidade: 'kg', precoUnitario: pyg(65.90) },
  { sku: 'QUE005', nome: 'Provolone',                   categoria: 'INGREDIENTE', unidade: 'kg', precoUnitario: pyg(49.90) },
  { sku: 'QUE006', nome: 'Queijo Coalho',               categoria: 'INGREDIENTE', unidade: 'kg', precoUnitario: pyg(43.90) },
  // CARNES
  { sku: 'CAR001', nome: 'Bacon Artesanal',             categoria: 'INGREDIENTE', unidade: 'kg', precoUnitario: pyg(34.90) },
  { sku: 'CAR002', nome: 'Calabresa Artesanal',         categoria: 'INGREDIENTE', unidade: 'kg', precoUnitario: pyg(28.90) },
  { sku: 'CAR003', nome: 'Pepperoni',                   categoria: 'INGREDIENTE', unidade: 'kg', precoUnitario: pyg(49.90) },
  { sku: 'CAR004', nome: 'Carne Seca',                  categoria: 'INGREDIENTE', unidade: 'kg', precoUnitario: pyg(69.90) },
  { sku: 'CAR005', nome: 'Carne Moída',                 categoria: 'INGREDIENTE', unidade: 'kg', precoUnitario: pyg(34.90) },
  { sku: 'CAR006', nome: 'Presunto',                    categoria: 'INGREDIENTE', unidade: 'kg', precoUnitario: pyg(27.90) },
  { sku: 'CAR007', nome: 'Hambúrguer Bovino 180g',      categoria: 'INGREDIENTE', unidade: 'un', precoUnitario: pyg(7.50)  },
  { sku: 'CAR008', nome: 'Alcatra',                     categoria: 'INGREDIENTE', unidade: 'kg', precoUnitario: pyg(58.90) },
  { sku: 'CAR009', nome: 'Picanha',                     categoria: 'INGREDIENTE', unidade: 'kg', precoUnitario: pyg(79.90) },
  { sku: 'CAR010', nome: 'Tilápia',                     categoria: 'INGREDIENTE', unidade: 'kg', precoUnitario: pyg(39.90) },
  { sku: 'CAR011', nome: 'Strogonoff de Carne',         categoria: 'INGREDIENTE', unidade: 'kg', precoUnitario: pyg(45.90) },
  // AVES
  { sku: 'FRA001', nome: 'Frango Desfiado',             categoria: 'INGREDIENTE', unidade: 'kg', precoUnitario: pyg(23.90) },
  { sku: 'FRA002', nome: 'Peito de Frango',             categoria: 'INGREDIENTE', unidade: 'kg', precoUnitario: pyg(21.90) },
  { sku: 'FRA003', nome: 'Frango a Passarinho',         categoria: 'INGREDIENTE', unidade: 'kg', precoUnitario: pyg(19.90) },
  // HORTIFRUTI
  { sku: 'HOR001', nome: 'Tomate',                      categoria: 'INGREDIENTE', unidade: 'kg',   precoUnitario: pyg(8.90)  },
  { sku: 'HOR002', nome: 'Cebola Branca',               categoria: 'INGREDIENTE', unidade: 'kg',   precoUnitario: pyg(6.90)  },
  { sku: 'HOR003', nome: 'Cebola Roxa',                 categoria: 'INGREDIENTE', unidade: 'kg',   precoUnitario: pyg(8.90)  },
  { sku: 'HOR004', nome: 'Alho Frito',                  categoria: 'INGREDIENTE', unidade: 'kg',   precoUnitario: pyg(34.90) },
  { sku: 'HOR005', nome: 'Milho (Choclo)',              categoria: 'INGREDIENTE', unidade: 'kg',   precoUnitario: pyg(11.90) },
  { sku: 'HOR006', nome: 'Azeitona Verde',              categoria: 'INGREDIENTE', unidade: 'kg',   precoUnitario: pyg(19.90) },
  { sku: 'HOR007', nome: 'Azeitona Preta',              categoria: 'INGREDIENTE', unidade: 'kg',   precoUnitario: pyg(23.90) },
  { sku: 'HOR008', nome: 'Champignon',                  categoria: 'INGREDIENTE', unidade: 'kg',   precoUnitario: pyg(36.90) },
  { sku: 'HOR009', nome: 'Pimentão (Locote)',           categoria: 'INGREDIENTE', unidade: 'kg',   precoUnitario: pyg(11.90) },
  { sku: 'HOR010', nome: 'Manjericão Fresco',           categoria: 'INGREDIENTE', unidade: 'maço', precoUnitario: pyg(4.50)  },
  { sku: 'HOR011', nome: 'Pepino em Conserva',          categoria: 'INGREDIENTE', unidade: 'kg',   precoUnitario: pyg(21.90) },
  { sku: 'HOR012', nome: 'Palmito',                     categoria: 'INGREDIENTE', unidade: 'kg',   precoUnitario: pyg(34.90) },
  { sku: 'HOR013', nome: 'Pimenta Biquinho',            categoria: 'INGREDIENTE', unidade: 'kg',   precoUnitario: pyg(42.90) },
  { sku: 'HOR014', nome: 'Salsa',                       categoria: 'INGREDIENTE', unidade: 'maço', precoUnitario: pyg(3.50)  },
  { sku: 'HOR015', nome: 'Alface',                      categoria: 'INGREDIENTE', unidade: 'un',   precoUnitario: pyg(3.90)  },
  { sku: 'HOR016', nome: 'Banana',                      categoria: 'INGREDIENTE', unidade: 'kg',   precoUnitario: pyg(6.90)  },
  { sku: 'HOR017', nome: 'Morango',                     categoria: 'INGREDIENTE', unidade: 'kg',   precoUnitario: pyg(24.90) },
  { sku: 'HOR018', nome: 'Abacaxi',                     categoria: 'INGREDIENTE', unidade: 'un',   precoUnitario: pyg(14.90) },
  { sku: 'HOR019', nome: 'Pêssego',                     categoria: 'INGREDIENTE', unidade: 'kg',   precoUnitario: pyg(18.90) },
  { sku: 'HOR020', nome: 'Limão',                       categoria: 'INGREDIENTE', unidade: 'kg',   precoUnitario: pyg(7.90)  },
  // DOCES
  { sku: 'DOC001', nome: 'Chocolate Meio Amargo',             categoria: 'INGREDIENTE', unidade: 'kg', precoUnitario: pyg(39.90) },
  { sku: 'DOC002', nome: 'Chocolate Branco',                  categoria: 'INGREDIENTE', unidade: 'kg', precoUnitario: pyg(42.90) },
  { sku: 'DOC003', nome: 'Nutella',                           categoria: 'INGREDIENTE', unidade: 'kg', precoUnitario: pyg(59.90) },
  { sku: 'DOC004', nome: 'Leite Condensado',                  categoria: 'INGREDIENTE', unidade: 'kg', precoUnitario: pyg(14.90) },
  { sku: 'DOC005', nome: 'Goiabada',                          categoria: 'INGREDIENTE', unidade: 'kg', precoUnitario: pyg(18.90) },
  { sku: 'DOC006', nome: 'Coco Ralado',                       categoria: 'INGREDIENTE', unidade: 'kg', precoUnitario: pyg(27.90) },
  { sku: 'DOC007', nome: 'Canela em Pó',                      categoria: 'INGREDIENTE', unidade: 'kg', precoUnitario: pyg(39.90) },
  { sku: 'DOC008', nome: 'Bombom Ouro Branco',                categoria: 'INGREDIENTE', unidade: 'un', precoUnitario: pyg(2.80)  },
  { sku: 'DOC009', nome: 'Bombom Sonho de Valsa / Ouro Negro',categoria: 'INGREDIENTE', unidade: 'un', precoUnitario: pyg(2.80)  },
  // TEMPEROS
  { sku: 'TEM001', nome: 'Orégano',           categoria: 'INGREDIENTE', unidade: 'kg',    precoUnitario: pyg(79.90)  },
  { sku: 'TEM002', nome: 'Pimenta-do-Reino',  categoria: 'INGREDIENTE', unidade: 'kg',    precoUnitario: pyg(89.90)  },
  { sku: 'TEM003', nome: 'Pimenta Calabresa', categoria: 'INGREDIENTE', unidade: 'kg',    precoUnitario: pyg(52.90)  },
  { sku: 'TEM004', nome: 'Sal Refinado',      categoria: 'INGREDIENTE', unidade: 'kg',    precoUnitario: pyg(3.90)   },
  { sku: 'TEM005', nome: 'Azeite de Oliva',   categoria: 'INGREDIENTE', unidade: 'litro', precoUnitario: pyg(49.90)  },
  // INSUMOS
  { sku: 'INS001', nome: 'Ovo',                        categoria: 'INGREDIENTE', unidade: 'un',    precoUnitario: pyg(1.00)  },
  { sku: 'INS002', nome: 'Batata Palha',               categoria: 'INGREDIENTE', unidade: 'kg',    precoUnitario: pyg(28.90) },
  { sku: 'INS003', nome: 'Batata Pré-frita Congelada', categoria: 'INGREDIENTE', unidade: 'kg',    precoUnitario: pyg(16.90) },
  { sku: 'INS004', nome: 'Mandioca Congelada',         categoria: 'INGREDIENTE', unidade: 'kg',    precoUnitario: pyg(13.90) },
  { sku: 'INS005', nome: 'Pão de Hambúrguer',          categoria: 'INGREDIENTE', unidade: 'un',    precoUnitario: pyg(1.20)  },
  { sku: 'INS006', nome: 'Fermento Biológico Seco',    categoria: 'INGREDIENTE', unidade: 'kg',    precoUnitario: pyg(49.90) },
  { sku: 'INS007', nome: 'Farinha de Trigo Especial',  categoria: 'INGREDIENTE', unidade: 'kg',    precoUnitario: pyg(5.90)  },
  { sku: 'INS008', nome: 'Açúcar',                     categoria: 'INGREDIENTE', unidade: 'kg',    precoUnitario: pyg(4.90)  },
  { sku: 'INS009', nome: 'Óleo de Soja',               categoria: 'INGREDIENTE', unidade: 'litro', precoUnitario: pyg(8.90)  },
  { sku: 'INS010', nome: 'Margarina',                  categoria: 'INGREDIENTE', unidade: 'kg',    precoUnitario: pyg(13.90) },
  // BEBIDAS
  { sku: 'BEB001', nome: 'Coca-Cola 350ml',        categoria: 'BEBIDA', unidade: 'un', precoUnitario: pyg(3.80)  },
  { sku: 'BEB002', nome: 'Coca-Cola 600ml',        categoria: 'BEBIDA', unidade: 'un', precoUnitario: pyg(5.90)  },
  { sku: 'BEB003', nome: 'Coca-Cola 2L',           categoria: 'BEBIDA', unidade: 'un', precoUnitario: pyg(10.90) },
  { sku: 'BEB004', nome: 'Coca-Cola Zero 350ml',   categoria: 'BEBIDA', unidade: 'un', precoUnitario: pyg(3.90)  },
  { sku: 'BEB005', nome: 'Coca-Cola Zero 2L',      categoria: 'BEBIDA', unidade: 'un', precoUnitario: pyg(11.50) },
  { sku: 'BEB006', nome: 'Guaraná Antarctica 2L',  categoria: 'BEBIDA', unidade: 'un', precoUnitario: pyg(9.90)  },
  { sku: 'BEB007', nome: 'Fanta Laranja 2L',       categoria: 'BEBIDA', unidade: 'un', precoUnitario: pyg(9.50)  },
  { sku: 'BEB008', nome: 'Sprite 2L',              categoria: 'BEBIDA', unidade: 'un', precoUnitario: pyg(9.90)  },
  { sku: 'BEB009', nome: 'Água Mineral 500ml',     categoria: 'BEBIDA', unidade: 'un', precoUnitario: pyg(2.20)  },
  { sku: 'BEB010', nome: 'Água com Gás',           categoria: 'BEBIDA', unidade: 'un', precoUnitario: pyg(2.80)  },
  { sku: 'BEB011', nome: 'Suco Lata',              categoria: 'BEBIDA', unidade: 'un', precoUnitario: pyg(4.50)  },
  { sku: 'BEB012', nome: 'Cerveja Long Neck',      categoria: 'BEBIDA', unidade: 'un', precoUnitario: pyg(7.90)  },
  // EMBALAGENS
  { sku: 'EMB001', nome: 'Caixa de Pizza Broto',        categoria: 'EMBALAGEM', unidade: 'un',   precoUnitario: pyg(1.20)  },
  { sku: 'EMB002', nome: 'Caixa de Pizza Média',        categoria: 'EMBALAGEM', unidade: 'un',   precoUnitario: pyg(1.50)  },
  { sku: 'EMB003', nome: 'Caixa de Pizza Grande',       categoria: 'EMBALAGEM', unidade: 'un',   precoUnitario: pyg(1.80)  },
  { sku: 'EMB004', nome: 'Caixa de Pizza Família',      categoria: 'EMBALAGEM', unidade: 'un',   precoUnitario: pyg(2.30)  },
  { sku: 'EMB005', nome: 'Sacola Pequena',              categoria: 'EMBALAGEM', unidade: 'un',   precoUnitario: pyg(0.95)  },
  { sku: 'EMB006', nome: 'Sacola Média',                categoria: 'EMBALAGEM', unidade: 'un',   precoUnitario: pyg(0.75)  },
  { sku: 'EMB007', nome: 'Sacola Grande',               categoria: 'EMBALAGEM', unidade: 'un',   precoUnitario: pyg(1.50)  },
  { sku: 'EMB008', nome: 'Guardanapo',                  categoria: 'EMBALAGEM', unidade: 'un',   precoUnitario: pyg(0.18)  },
  { sku: 'EMB009', nome: 'Embalagem Porção Média',      categoria: 'EMBALAGEM', unidade: 'un',   precoUnitario: pyg(0.28)  },
  { sku: 'EMB010', nome: 'Embalagem Porção Pequena',    categoria: 'EMBALAGEM', unidade: 'un',   precoUnitario: pyg(0.12)  },
  { sku: 'EMB011', nome: 'Embalagem Hambúrguer',        categoria: 'EMBALAGEM', unidade: 'un',   precoUnitario: pyg(0.15)  },
  { sku: 'EMB012', nome: 'Copo Descartável 200ml',      categoria: 'EMBALAGEM', unidade: 'un',   precoUnitario: pyg(0.45)  },
  { sku: 'EMB013', nome: 'Copo Descartável 500ml',      categoria: 'EMBALAGEM', unidade: 'un',   precoUnitario: pyg(0.70)  },
  { sku: 'EMB014', nome: 'Palito Descartável',          categoria: 'EMBALAGEM', unidade: 'un',   precoUnitario: pyg(0.08)  },
  { sku: 'EMB015', nome: 'Papel Manteiga',              categoria: 'EMBALAGEM', unidade: 'metro', precoUnitario: pyg(0.70)  },
  // DESCARTÁVEIS
  { sku: 'DES001', nome: 'Canudo',                      categoria: 'EMBALAGEM', unidade: 'un',   precoUnitario: pyg(0.03)  },
  { sku: 'DES002', nome: 'Garfo Descartável',           categoria: 'EMBALAGEM', unidade: 'un',   precoUnitario: pyg(0.15)  },
  { sku: 'DES003', nome: 'Faca Descartável',            categoria: 'EMBALAGEM', unidade: 'un',   precoUnitario: pyg(0.15)  },
  { sku: 'DES004', nome: 'Colher Descartável',          categoria: 'EMBALAGEM', unidade: 'un',   precoUnitario: pyg(0.15)  },
  { sku: 'DES005', nome: 'Prato Descartável Pequeno',   categoria: 'EMBALAGEM', unidade: 'un',   precoUnitario: pyg(0.08)  },
  { sku: 'DES006', nome: 'Prato Descartável Médio',     categoria: 'EMBALAGEM', unidade: 'un',   precoUnitario: pyg(0.18)  },
  { sku: 'DES007', nome: 'Prato Descartável Grande',    categoria: 'EMBALAGEM', unidade: 'un',   precoUnitario: pyg(0.18)  },
  { sku: 'DES008', nome: 'Bandeja Descartável',         categoria: 'EMBALAGEM', unidade: 'un',   precoUnitario: pyg(0.20)  },
  { sku: 'DES009', nome: 'Marmita Descartável',         categoria: 'EMBALAGEM', unidade: 'un',   precoUnitario: pyg(0.35)  },
  { sku: 'DES010', nome: 'Palito de Dente',             categoria: 'EMBALAGEM', unidade: 'un',   precoUnitario: pyg(0.10)  },
  // LIMPEZA
  { sku: 'LIM001', nome: 'Detergente Líquido',          categoria: 'LIMPEZA', unidade: 'litro', precoUnitario: pyg(4.90)   },
  { sku: 'LIM002', nome: 'Desengordurante',             categoria: 'LIMPEZA', unidade: 'litro', precoUnitario: pyg(5.90)   },
  { sku: 'LIM003', nome: 'Álcool 70%',                  categoria: 'LIMPEZA', unidade: 'litro', precoUnitario: pyg(18.90)  },
  { sku: 'LIM004', nome: 'Água Sanitária',              categoria: 'LIMPEZA', unidade: 'litro', precoUnitario: pyg(9.90)   },
  { sku: 'LIM005', nome: 'Multiuso Limpeza',            categoria: 'LIMPEZA', unidade: 'litro', precoUnitario: pyg(12.90)  },
  { sku: 'LIM006', nome: 'Esponja de Limpeza',          categoria: 'LIMPEZA', unidade: 'rolo',  precoUnitario: pyg(7.90)   },
  { sku: 'LIM007', nome: 'Papel Toalha',                categoria: 'LIMPEZA', unidade: 'rolo',  precoUnitario: pyg(2.50)   },
  { sku: 'LIM008', nome: 'Pano de Prato',               categoria: 'LIMPEZA', unidade: 'un',    precoUnitario: pyg(2.50)   },
  { sku: 'LIM009', nome: 'Luva Descartável',            categoria: 'LIMPEZA', unidade: 'un',    precoUnitario: pyg(0.70)   },
  { sku: 'LIM010', nome: 'Saco de Lixo',                categoria: 'LIMPEZA', unidade: 'un',    precoUnitario: pyg(1.10)   },
  // GÁS
  { sku: 'GAS001', nome: 'Gás GLP P45',                 categoria: 'OUTROS', unidade: 'un',    precoUnitario: pyg(420.00)  },
  { sku: 'GAS002', nome: 'Gás GLP P13',                 categoria: 'OUTROS', unidade: 'un',    precoUnitario: pyg(120.00)  },
  // UTILIDADES
  { sku: 'UTI001', nome: 'Papel Alumínio',              categoria: 'OUTROS', unidade: 'rolo',   precoUnitario: pyg(34.90)  },
  { sku: 'UTI002', nome: 'Filme PVC',                   categoria: 'OUTROS', unidade: 'caixa',  precoUnitario: pyg(34.90)  },
  { sku: 'UTI003', nome: 'Saco Plástico Transparente',  categoria: 'OUTROS', unidade: 'pacote', precoUnitario: pyg(19.90)  },
  { sku: 'UTI004', nome: 'Fita Adesiva',                categoria: 'OUTROS', unidade: 'caixa',  precoUnitario: pyg(22.90)  },
  { sku: 'UTI005', nome: 'Bobina Impressora',           categoria: 'OUTROS', unidade: 'rolo',   precoUnitario: pyg(12.90)  },
];

// ── Receitas pizzas salgadas (tamanho "Grande", categoria pizza excluindo doce) ─
const RECEITAS_PIZZA_SALGADA = [
  { nome: '3 Fronteras', ingredientes: [
    { sku: 'MAS003', qty: 1 }, { sku: 'MOL001', qty: 0.08 }, { sku: 'QUE001', qty: 0.25 },
    { sku: 'HOR004', qty: 0.02 }, { sku: 'CAR001', qty: 0.08 }, { sku: 'HOR008', qty: 0.06 }, { sku: 'TEM001', qty: 0.002 },
  ]},
  { nome: '4 Quesos', ingredientes: [
    { sku: 'MAS003', qty: 1 }, { sku: 'MOL001', qty: 0.08 }, { sku: 'QUE001', qty: 0.18 },
    { sku: 'QUE004', qty: 0.04 }, { sku: 'QUE005', qty: 0.07 }, { sku: 'QUE003', qty: 0.08 }, { sku: 'TEM001', qty: 0.002 },
  ]},
  { nome: 'Acebollada', ingredientes: [
    { sku: 'MAS003', qty: 1 }, { sku: 'MOL001', qty: 0.08 }, { sku: 'QUE001', qty: 0.22 },
    { sku: 'HOR002', qty: 0.04 }, { sku: 'HOR003', qty: 0.04 }, { sku: 'HOR006', qty: 0.015 },
    { sku: 'CAR003', qty: 0.09 }, { sku: 'TEM001', qty: 0.002 },
  ]},
  { nome: 'Ali Oli', ingredientes: [
    { sku: 'MAS003', qty: 1 }, { sku: 'MOL001', qty: 0.08 }, { sku: 'QUE001', qty: 0.30 },
    { sku: 'HOR004', qty: 0.025 }, { sku: 'TEM001', qty: 0.002 },
  ]},
  { nome: 'Americana', ingredientes: [
    { sku: 'MAS003', qty: 1 }, { sku: 'MOL001', qty: 0.08 }, { sku: 'QUE001', qty: 0.22 },
    { sku: 'CAR001', qty: 0.08 }, { sku: 'HOR005', qty: 0.04 }, { sku: 'INS001', qty: 2 },
    { sku: 'QUE002', qty: 0.12 }, { sku: 'TEM001', qty: 0.002 },
  ]},
  { nome: 'Bacon', ingredientes: [
    { sku: 'MAS003', qty: 1 }, { sku: 'MOL001', qty: 0.08 }, { sku: 'QUE001', qty: 0.25 },
    { sku: 'CAR001', qty: 0.12 }, { sku: 'HOR007', qty: 0.015 }, { sku: 'TEM001', qty: 0.002 },
  ]},
  { nome: 'Baconcat', ingredientes: [
    { sku: 'MAS003', qty: 1 }, { sku: 'MOL001', qty: 0.08 }, { sku: 'QUE001', qty: 0.20 },
    { sku: 'CAR001', qty: 0.09 }, { sku: 'HOR003', qty: 0.04 }, { sku: 'QUE002', qty: 0.12 },
    { sku: 'HOR006', qty: 0.015 }, { sku: 'TEM001', qty: 0.002 },
  ]},
  { nome: 'Baiana', ingredientes: [
    { sku: 'MAS003', qty: 1 }, { sku: 'MOL001', qty: 0.08 }, { sku: 'QUE001', qty: 0.22 },
    { sku: 'CAR002', qty: 0.12 }, { sku: 'HOR001', qty: 0.04 }, { sku: 'HOR003', qty: 0.04 },
    { sku: 'HOR009', qty: 0.03 }, { sku: 'TEM002', qty: 0.001 }, { sku: 'TEM001', qty: 0.002 },
  ]},
  { nome: 'Burguer', catIncludes: ['pizza'], catExcludes: ['doce'], ingredientes: [
    { sku: 'MAS003', qty: 1 }, { sku: 'MOL001', qty: 0.08 }, { sku: 'QUE001', qty: 0.18 },
    { sku: 'CAR005', qty: 0.14 }, { sku: 'HOR003', qty: 0.04 }, { sku: 'HOR011', qty: 0.03 },
    { sku: 'QUE003', qty: 0.10 }, { sku: 'TEM001', qty: 0.002 },
  ]},
  { nome: 'Caipira', ingredientes: [
    { sku: 'MAS003', qty: 1 }, { sku: 'MOL001', qty: 0.08 }, { sku: 'QUE001', qty: 0.20 },
    { sku: 'FRA001', qty: 0.14 }, { sku: 'HOR005', qty: 0.04 }, { sku: 'QUE002', qty: 0.12 }, { sku: 'TEM001', qty: 0.002 },
  ]},
  { nome: 'Calabacon', ingredientes: [
    { sku: 'MAS003', qty: 1 }, { sku: 'MOL001', qty: 0.08 }, { sku: 'QUE001', qty: 0.22 },
    { sku: 'CAR002', qty: 0.10 }, { sku: 'CAR001', qty: 0.08 }, { sku: 'TEM001', qty: 0.002 },
  ]},
  { nome: 'Calabresa', catIncludes: ['pizza'], catExcludes: ['doce'], ingredientes: [
    { sku: 'MAS003', qty: 1 }, { sku: 'MOL002', qty: 0.08 }, { sku: 'QUE001', qty: 0.24 },
    { sku: 'CAR002', qty: 0.16 }, { sku: 'TEM001', qty: 0.002 },
  ]},
  { nome: 'Carne Seca', ingredientes: [
    { sku: 'MAS003', qty: 1 }, { sku: 'MOL001', qty: 0.08 }, { sku: 'QUE001', qty: 0.18 },
    { sku: 'CAR004', qty: 0.15 }, { sku: 'HOR003', qty: 0.04 }, { sku: 'HOR013', qty: 0.02 },
    { sku: 'QUE002', qty: 0.12 }, { sku: 'HOR014', qty: 0.005 },
  ]},
  { nome: 'Catubacon', ingredientes: [
    { sku: 'MAS003', qty: 1 }, { sku: 'MOL001', qty: 0.08 }, { sku: 'QUE001', qty: 0.22 },
    { sku: 'CAR001', qty: 0.10 }, { sku: 'QUE002', qty: 0.12 }, { sku: 'TEM001', qty: 0.002 },
  ]},
  { nome: 'Catubresa', ingredientes: [
    { sku: 'MAS003', qty: 1 }, { sku: 'MOL001', qty: 0.08 }, { sku: 'QUE001', qty: 0.22 },
    { sku: 'CAR002', qty: 0.12 }, { sku: 'QUE002', qty: 0.12 }, { sku: 'TEM001', qty: 0.002 },
  ]},
  { nome: 'Choclo', ingredientes: [
    { sku: 'MAS003', qty: 1 }, { sku: 'MOL001', qty: 0.08 }, { sku: 'QUE001', qty: 0.28 },
    { sku: 'HOR005', qty: 0.08 }, { sku: 'TEM001', qty: 0.002 },
  ]},
  { nome: 'Doritos', catIncludes: ['pizza'], catExcludes: ['doce'], ingredientes: [
    { sku: 'MAS003', qty: 1 }, { sku: 'MOL001', qty: 0.08 }, { sku: 'QUE001', qty: 0.18 },
    { sku: 'CAR005', qty: 0.14 }, { sku: 'QUE003', qty: 0.10 }, { sku: 'INS002', qty: 0.04 }, { sku: 'TEM001', qty: 0.002 },
  ]},
  { nome: 'Du Cheff', ingredientes: [
    { sku: 'MAS003', qty: 1 }, { sku: 'MOL002', qty: 0.08 }, { sku: 'QUE001', qty: 0.20 },
    { sku: 'CAR005', qty: 0.15 }, { sku: 'QUE002', qty: 0.12 }, { sku: 'TEM001', qty: 0.002 },
  ]},
  { nome: 'Española', ingredientes: [
    { sku: 'MAS003', qty: 1 }, { sku: 'MOL001', qty: 0.08 }, { sku: 'QUE001', qty: 0.24 },
    { sku: 'HOR002', qty: 0.04 }, { sku: 'HOR009', qty: 0.04 }, { sku: 'HOR006', qty: 0.02 }, { sku: 'TEM001', qty: 0.002 },
  ]},
  { nome: 'Marguerita', ingredientes: [
    { sku: 'MAS003', qty: 1 }, { sku: 'MOL001', qty: 0.08 }, { sku: 'QUE001', qty: 0.26 },
    { sku: 'HOR001', qty: 0.08 }, { sku: 'HOR010', qty: 0.01 }, { sku: 'TEM001', qty: 0.002 },
  ]},
  { nome: 'Mexicana', ingredientes: [
    { sku: 'MAS003', qty: 1 }, { sku: 'MOL001', qty: 0.08 }, { sku: 'QUE001', qty: 0.18 },
    { sku: 'CAR005', qty: 0.15 }, { sku: 'HOR003', qty: 0.04 }, { sku: 'HOR009', qty: 0.04 },
    { sku: 'HOR006', qty: 0.02 }, { sku: 'TEM003', qty: 0.003 }, { sku: 'TEM001', qty: 0.002 },
  ]},
  { nome: 'Moda de la Casa', ingredientes: [
    { sku: 'MAS003', qty: 1 }, { sku: 'MOL001', qty: 0.08 }, { sku: 'QUE001', qty: 0.18 },
    { sku: 'FRA001', qty: 0.07 }, { sku: 'CAR001', qty: 0.05 }, { sku: 'CAR002', qty: 0.06 },
    { sku: 'HOR005', qty: 0.04 }, { sku: 'HOR006', qty: 0.015 }, { sku: 'HOR001', qty: 0.04 },
    { sku: 'QUE002', qty: 0.10 }, { sku: 'TEM001', qty: 0.002 },
  ]},
  { nome: 'Mozzarella', catIncludes: ['pizza'], catExcludes: ['doce'], ingredientes: [
    { sku: 'MAS003', qty: 1 }, { sku: 'MOL001', qty: 0.08 }, { sku: 'QUE001', qty: 0.32 },
    { sku: 'HOR007', qty: 0.02 }, { sku: 'TEM001', qty: 0.002 },
  ]},
  { nome: 'Napolitana', ingredientes: [
    { sku: 'MAS003', qty: 1 }, { sku: 'MOL001', qty: 0.08 }, { sku: 'QUE001', qty: 0.25 },
    { sku: 'HOR001', qty: 0.08 }, { sku: 'HOR007', qty: 0.02 }, { sku: 'TEM001', qty: 0.002 },
  ]},
  { nome: 'Norteña', ingredientes: [
    { sku: 'MAS003', qty: 1 }, { sku: 'MOL001', qty: 0.08 }, { sku: 'QUE001', qty: 0.17 },
    { sku: 'CAR004', qty: 0.15 }, { sku: 'HOR003', qty: 0.04 }, { sku: 'QUE006', qty: 0.08 },
    { sku: 'HOR013', qty: 0.02 }, { sku: 'MOL003', qty: 0.04 },
  ]},
  { nome: 'Palmito', ingredientes: [
    { sku: 'MAS003', qty: 1 }, { sku: 'MOL001', qty: 0.08 }, { sku: 'QUE001', qty: 0.25 },
    { sku: 'HOR012', qty: 0.10 }, { sku: 'HOR007', qty: 0.02 }, { sku: 'TEM001', qty: 0.002 },
  ]},
  { nome: 'Paraguaya', ingredientes: [
    { sku: 'MAS003', qty: 1 }, { sku: 'MOL001', qty: 0.08 }, { sku: 'QUE001', qty: 0.22 },
    { sku: 'CAR001', qty: 0.08 }, { sku: 'HOR004', qty: 0.02 }, { sku: 'HOR006', qty: 0.02 }, { sku: 'TEM001', qty: 0.002 },
  ]},
  { nome: 'Pepperoni', catIncludes: ['pizza'], catExcludes: ['doce'], ingredientes: [
    { sku: 'MAS003', qty: 1 }, { sku: 'MOL001', qty: 0.08 }, { sku: 'QUE001', qty: 0.22 },
    { sku: 'CAR003', qty: 0.14 }, { sku: 'HOR007', qty: 0.02 }, { sku: 'TEM001', qty: 0.002 },
  ]},
  { nome: 'Pollo Catupiry', ingredientes: [
    { sku: 'MAS003', qty: 1 }, { sku: 'MOL001', qty: 0.08 }, { sku: 'QUE001', qty: 0.18 },
    { sku: 'FRA001', qty: 0.15 }, { sku: 'QUE002', qty: 0.12 }, { sku: 'HOR006', qty: 0.015 }, { sku: 'TEM001', qty: 0.002 },
  ]},
  { nome: 'Portuguesa', ingredientes: [
    { sku: 'MAS003', qty: 1 }, { sku: 'MOL001', qty: 0.08 }, { sku: 'QUE001', qty: 0.18 },
    { sku: 'CAR006', qty: 0.12 }, { sku: 'HOR003', qty: 0.04 }, { sku: 'HOR009', qty: 0.03 },
    { sku: 'HOR001', qty: 0.04 }, { sku: 'INS001', qty: 2 }, { sku: 'HOR006', qty: 0.02 }, { sku: 'TEM001', qty: 0.002 },
  ]},
  { nome: 'Primavera', ingredientes: [
    { sku: 'MAS003', qty: 1 }, { sku: 'MOL001', qty: 0.08 }, { sku: 'QUE001', qty: 0.20 },
    { sku: 'CAR006', qty: 0.10 }, { sku: 'HOR001', qty: 0.04 }, { sku: 'HOR012', qty: 0.06 },
    { sku: 'HOR005', qty: 0.04 }, { sku: 'HOR007', qty: 0.02 }, { sku: 'TEM001', qty: 0.002 },
  ]},
  { nome: 'Siciliana', ingredientes: [
    { sku: 'MAS003', qty: 1 }, { sku: 'MOL001', qty: 0.08 }, { sku: 'QUE001', qty: 0.22 },
    { sku: 'HOR001', qty: 0.05 }, { sku: 'CAR001', qty: 0.08 }, { sku: 'QUE002', qty: 0.10 }, { sku: 'TEM001', qty: 0.002 },
  ]},
  { nome: 'Strogonoff de Carne', ingredientes: [
    { sku: 'MAS003', qty: 1 }, { sku: 'MOL001', qty: 0.08 }, { sku: 'QUE001', qty: 0.18 },
    { sku: 'CAR011', qty: 0.18 }, { sku: 'INS002', qty: 0.05 }, { sku: 'TEM001', qty: 0.002 },
  ]},
];

// ── Receitas pizzas doces (tamanho "Grande", categoria doce) ──────────────────
const RECEITAS_PIZZA_DOCE = [
  { nome: '2 Amores', ingredientes: [
    { sku: 'MAS005', qty: 1 }, { sku: 'DOC004', qty: 0.12 }, { sku: 'QUE001', qty: 0.18 },
    { sku: 'DOC001', qty: 0.12 }, { sku: 'DOC002', qty: 0.12 },
  ]},
  { nome: 'Banana', catIncludes: ['doce'], ingredientes: [
    { sku: 'MAS005', qty: 1 }, { sku: 'DOC004', qty: 0.12 }, { sku: 'QUE001', qty: 0.18 },
    { sku: 'HOR016', qty: 0.18 }, { sku: 'DOC007', qty: 0.005 },
  ]},
  { nome: 'Banana Nevada', ingredientes: [
    { sku: 'MAS005', qty: 1 }, { sku: 'DOC004', qty: 0.12 }, { sku: 'QUE001', qty: 0.18 },
    { sku: 'HOR016', qty: 0.18 }, { sku: 'DOC002', qty: 0.12 },
  ]},
  { nome: 'Bananoll', ingredientes: [
    { sku: 'MAS005', qty: 1 }, { sku: 'DOC004', qty: 0.12 }, { sku: 'QUE001', qty: 0.18 },
    { sku: 'HOR016', qty: 0.18 }, { sku: 'DOC001', qty: 0.12 }, { sku: 'DOC007', qty: 0.005 },
  ]},
  { nome: 'Beijiño', ingredientes: [
    { sku: 'MAS005', qty: 1 }, { sku: 'DOC004', qty: 0.12 }, { sku: 'QUE001', qty: 0.18 },
    { sku: 'DOC002', qty: 0.14 }, { sku: 'DOC006', qty: 0.04 },
  ]},
  { nome: 'Chocolate Blanco', catIncludes: ['doce'], ingredientes: [
    { sku: 'MAS005', qty: 1 }, { sku: 'DOC004', qty: 0.12 }, { sku: 'QUE001', qty: 0.18 },
    { sku: 'DOC002', qty: 0.18 },
  ]},
  { nome: 'Chocolate Blanco con Raspas de Limón', ingredientes: [
    { sku: 'MAS005', qty: 1 }, { sku: 'DOC004', qty: 0.12 }, { sku: 'QUE001', qty: 0.18 },
    { sku: 'DOC002', qty: 0.18 }, { sku: 'HOR020', qty: 0.005 },
  ]},
  { nome: 'Chocolate Negro', catIncludes: ['doce'], ingredientes: [
    { sku: 'MAS005', qty: 1 }, { sku: 'DOC004', qty: 0.12 }, { sku: 'QUE001', qty: 0.18 },
    { sku: 'DOC001', qty: 0.18 },
  ]},
  { nome: 'Nutella', catIncludes: ['doce'], ingredientes: [
    { sku: 'MAS005', qty: 1 }, { sku: 'DOC004', qty: 0.10 }, { sku: 'QUE001', qty: 0.16 },
    { sku: 'DOC003', qty: 0.18 }, { sku: 'HOR016', qty: 0.12 },
  ]},
  { nome: 'Oro Blanco', ingredientes: [
    { sku: 'MAS005', qty: 1 }, { sku: 'DOC004', qty: 0.10 }, { sku: 'DOC002', qty: 0.18 },
    { sku: 'HOR017', qty: 0.12 }, { sku: 'DOC008', qty: 3 },
  ]},
  { nome: 'Oro Negro', ingredientes: [
    { sku: 'MAS005', qty: 1 }, { sku: 'DOC004', qty: 0.10 }, { sku: 'DOC001', qty: 0.18 },
    { sku: 'HOR017', qty: 0.12 }, { sku: 'DOC009', qty: 3 },
  ]},
  { nome: 'Prestigio', catIncludes: ['doce'], ingredientes: [
    { sku: 'MAS005', qty: 1 }, { sku: 'DOC004', qty: 0.12 }, { sku: 'DOC001', qty: 0.18 },
    { sku: 'DOC006', qty: 0.04 },
  ]},
  { nome: 'Romeu y Julieta', ingredientes: [
    { sku: 'MAS005', qty: 1 }, { sku: 'DOC004', qty: 0.10 }, { sku: 'QUE001', qty: 0.18 },
    { sku: 'DOC005', qty: 0.18 },
  ]},
  { nome: 'Seducción', ingredientes: [
    { sku: 'MAS005', qty: 1 }, { sku: 'DOC004', qty: 0.10 }, { sku: 'DOC002', qty: 0.18 },
    { sku: 'HOR017', qty: 0.15 },
  ]},
  { nome: 'Sensación', ingredientes: [
    { sku: 'MAS005', qty: 1 }, { sku: 'DOC004', qty: 0.10 }, { sku: 'DOC001', qty: 0.18 },
    { sku: 'HOR017', qty: 0.15 },
  ]},
  { nome: 'Tropical', catIncludes: ['doce'], ingredientes: [
    { sku: 'MAS005', qty: 1 }, { sku: 'DOC004', qty: 0.10 }, { sku: 'QUE001', qty: 0.16 },
    { sku: 'HOR018', qty: 0.08 }, { sku: 'HOR017', qty: 0.08 }, { sku: 'HOR019', qty: 0.08 },
  ]},
];

// ── Receitas hambúrgueses ─────────────────────────────────────────────────────
const RECEITAS_HAMBURGER = [
  { nome: 'American Burguer', ingredientes: [
    { sku: 'INS005', qty: 1 }, { sku: 'CAR007', qty: 1 }, { sku: 'QUE003', qty: 0.04 },
    { sku: 'QUE002', qty: 0.04 }, { sku: 'HOR011', qty: 0.02 }, { sku: 'HOR002', qty: 0.025 },
    { sku: 'HOR015', qty: 0.02 }, { sku: 'HOR001', qty: 0.03 },
  ]},
  { nome: 'Burguer', catIncludes: ['hambur'], ingredientes: [
    { sku: 'INS005', qty: 1 }, { sku: 'CAR007', qty: 1 }, { sku: 'QUE003', qty: 0.04 },
    { sku: 'MOL006', qty: 0.03 }, { sku: 'INS003', qty: 0.18 },
  ]},
  { nome: 'Completa', ingredientes: [
    { sku: 'INS005', qty: 1 }, { sku: 'CAR007', qty: 1 }, { sku: 'HOR001', qty: 0.03 },
    { sku: 'HOR015', qty: 0.02 }, { sku: 'MOL006', qty: 0.03 }, { sku: 'INS001', qty: 1 },
    { sku: 'CAR002', qty: 0.04 }, { sku: 'CAR001', qty: 0.04 }, { sku: 'QUE003', qty: 0.04 },
    { sku: 'INS003', qty: 0.18 },
  ]},
  { nome: 'Doble Carne', ingredientes: [
    { sku: 'INS005', qty: 1 }, { sku: 'CAR007', qty: 2 }, { sku: 'HOR001', qty: 0.03 },
    { sku: 'HOR015', qty: 0.02 }, { sku: 'MOL006', qty: 0.03 }, { sku: 'INS001', qty: 1 },
    { sku: 'CAR002', qty: 0.04 }, { sku: 'CAR001', qty: 0.04 }, { sku: 'QUE003', qty: 0.05 },
    { sku: 'INS003', qty: 0.18 },
  ]},
  { nome: 'Hamburguesa Mexicana', ingredientes: [
    { sku: 'INS005', qty: 1 }, { sku: 'CAR007', qty: 1 }, { sku: 'MOL009', qty: 0.03 },
    { sku: 'HOR001', qty: 0.03 }, { sku: 'HOR015', qty: 0.02 }, { sku: 'QUE001', qty: 0.04 },
  ]},
  { nome: 'Hamburguesa Simples', ingredientes: [
    { sku: 'INS005', qty: 1 }, { sku: 'CAR007', qty: 1 }, { sku: 'HOR001', qty: 0.03 },
    { sku: 'HOR015', qty: 0.02 }, { sku: 'QUE003', qty: 0.04 }, { sku: 'INS003', qty: 0.18 },
  ]},
  { nome: 'X Bacon', ingredientes: [
    { sku: 'INS005', qty: 1 }, { sku: 'CAR007', qty: 1 }, { sku: 'MOL006', qty: 0.03 },
    { sku: 'CAR001', qty: 0.05 }, { sku: 'QUE003', qty: 0.04 }, { sku: 'INS003', qty: 0.18 },
  ]},
  { nome: 'X Calabresa', ingredientes: [
    { sku: 'INS005', qty: 1 }, { sku: 'CAR007', qty: 1 }, { sku: 'MOL006', qty: 0.03 },
    { sku: 'CAR002', qty: 0.05 }, { sku: 'QUE003', qty: 0.04 }, { sku: 'INS003', qty: 0.18 },
  ]},
  { nome: 'X Egg', ingredientes: [
    { sku: 'INS005', qty: 1 }, { sku: 'CAR007', qty: 1 }, { sku: 'QUE001', qty: 0.04 },
    { sku: 'INS001', qty: 1 },
  ]},
];

// ── Receitas porções ──────────────────────────────────────────────────────────
const RECEITAS_PORCAO = [
  { nome: 'Alcatra Acebolada', ingredientes: [
    { sku: 'CAR008', qty: 0.5 }, { sku: 'HOR002', qty: 0.1 }, { sku: 'INS004', qty: 0.3 },
  ]},
  { nome: 'Calabresa con Fritas', ingredientes: [
    { sku: 'CAR002', qty: 0.35 }, { sku: 'HOR002', qty: 0.08 }, { sku: 'INS003', qty: 0.3 },
  ]},
  { nome: 'Papa Frita', ingredientes: [
    { sku: 'INS003', qty: 0.5 }, { sku: 'MOL004', qty: 0.04 }, { sku: 'MOL005', qty: 0.04 },
  ]},
  { nome: 'Pechuga a la Plancha', ingredientes: [
    { sku: 'FRA002', qty: 0.3 }, { sku: 'HOR015', qty: 0.04 }, { sku: 'HOR001', qty: 0.05 },
  ]},
  { nome: 'Picaña', ingredientes: [
    { sku: 'CAR009', qty: 0.5 }, { sku: 'INS004', qty: 0.2 }, { sku: 'INS003', qty: 0.25 },
    { sku: 'MOL004', qty: 0.04 }, { sku: 'MOL005', qty: 0.04 },
  ]},
  { nome: 'Pollo a Passarinho', ingredientes: [
    { sku: 'FRA003', qty: 0.5 },
  ]},
  { nome: 'Tilapia Frita', ingredientes: [
    { sku: 'CAR010', qty: 0.5 }, { sku: 'MOL004', qty: 0.04 }, { sku: 'MOL005', qty: 0.04 },
  ]},
  { nome: 'Trio Delicia', ingredientes: [
    { sku: 'CAR002', qty: 0.18 }, { sku: 'FRA003', qty: 0.18 }, { sku: 'INS003', qty: 0.3 },
  ]},
];

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const restaurante = await prisma.restaurante.findFirst({
    where: { nome: { contains: 'Don Pedro', mode: 'insensitive' } },
  });
  if (!restaurante) throw new Error('Restaurante Don Pedro não encontrado');
  const rid = restaurante.id;
  console.log(`\nRestaurante: ${restaurante.nome} (${rid})\n`);

  // 1. Upsert ItemEstoque
  console.log('── Inserindo ingredientes no estoque ───────────────────────────');
  const estoqueMap = {};
  let criados = 0, atualizados = 0;

  for (const ing of INGREDIENTES) {
    let item = await prisma.itemEstoque.findFirst({ where: { restauranteId: rid, sku: ing.sku } });
    if (!item) {
      item = await prisma.itemEstoque.create({ data: { restauranteId: rid, ...ing } });
      console.log(`  ✅ [NOVO]  ${ing.sku}  ${ing.nome}  ${ing.precoUnitario.toLocaleString()} Gs`);
      criados++;
    } else {
      item = await prisma.itemEstoque.update({
        where: { id: item.id },
        data: { nome: ing.nome, categoria: ing.categoria, unidade: ing.unidade, precoUnitario: ing.precoUnitario },
      });
      atualizados++;
    }
    estoqueMap[ing.sku] = item.id;
  }
  console.log(`\n  Total: ${criados} criados, ${atualizados} atualizados\n`);

  // 2. Carregar produtos com categoria
  const allProdutos = await prisma.produto.findMany({
    where: { categoria: { restauranteId: rid } },
    include: { tamanhos: true, categoria: true },
  });

  function findProduto(nome, catIncludes = null, catExcludes = null) {
    const n = norm(nome);
    let candidates = allProdutos.filter(p => norm(p.nome) === n);
    if (catIncludes) candidates = candidates.filter(p => catIncludes.some(s => norm(p.categoria.nome).includes(s)));
    if (catExcludes) candidates = candidates.filter(p => !catExcludes.some(s => norm(p.categoria.nome).includes(s)));
    return candidates[0] || null;
  }

  function findGrandeTamanho(produto) {
    if (!produto.tamanhos || produto.tamanhos.length === 0) return null;
    return produto.tamanhos.find(t => /grande/i.test(t.nome)) || null;
  }

  async function criarReceita(produtoId, tamanhoId, ingredientes, label) {
    await prisma.receitaItem.deleteMany({
      where: { restauranteId: rid, produtoId, tamanhoId: tamanhoId || null },
    });
    let ok = 0;
    for (const { sku, qty } of ingredientes) {
      const itemEstoqueId = estoqueMap[sku];
      if (!itemEstoqueId) { console.warn(`    ⚠️  SKU não encontrado: ${sku}`); continue; }
      await prisma.receitaItem.create({
        data: { restauranteId: rid, produtoId, tamanhoId: tamanhoId || null, itemEstoqueId, quantidade: qty },
      });
      ok++;
    }
    console.log(`  ✅ ${label} — ${ok} ingredientes`);
  }

  // 3. Receitas pizzas salgadas
  console.log('── Receitas Pizza Salgada ───────────────────────────────────────');
  for (const r of RECEITAS_PIZZA_SALGADA) {
    const ci = r.catIncludes || ['pizza'];
    const ce = r.catExcludes || ['doce'];
    const produto = findProduto(r.nome, ci, ce);
    if (!produto) { console.warn(`  ⚠️  Produto não encontrado: "${r.nome}"`); continue; }
    const tamanho = findGrandeTamanho(produto);
    await criarReceita(produto.id, tamanho ? tamanho.id : null, r.ingredientes,
      `${produto.nome}${tamanho ? ` [${tamanho.nome}]` : ''}`);
  }

  // 4. Receitas pizzas doces
  console.log('\n── Receitas Pizza Doce ──────────────────────────────────────────');
  for (const r of RECEITAS_PIZZA_DOCE) {
    const ci = r.catIncludes || ['doce'];
    const produto = findProduto(r.nome, ci, null);
    if (!produto) { console.warn(`  ⚠️  Produto não encontrado: "${r.nome}"`); continue; }
    const tamanho = findGrandeTamanho(produto);
    await criarReceita(produto.id, tamanho ? tamanho.id : null, r.ingredientes,
      `${produto.nome}${tamanho ? ` [${tamanho.nome}]` : ''}`);
  }

  // 5. Receitas hambúrgueses
  console.log('\n── Receitas Hambúrgueses ────────────────────────────────────────');
  for (const r of RECEITAS_HAMBURGER) {
    const ci = r.catIncludes || null;
    const produto = findProduto(r.nome, ci, null);
    if (!produto) { console.warn(`  ⚠️  Produto não encontrado: "${r.nome}"`); continue; }
    await criarReceita(produto.id, null, r.ingredientes, produto.nome);
  }

  // 6. Receitas porções
  console.log('\n── Receitas Porções ─────────────────────────────────────────────');
  for (const r of RECEITAS_PORCAO) {
    const produto = findProduto(r.nome);
    if (!produto) { console.warn(`  ⚠️  Produto não encontrado: "${r.nome}"`); continue; }
    await criarReceita(produto.id, null, r.ingredientes, produto.nome);
  }

  const totalEstoque = await prisma.itemEstoque.count({ where: { restauranteId: rid } });
  const totalReceitas = await prisma.receitaItem.count({ where: { restauranteId: rid } });
  console.log(`\n✅ Concluído!`);
  console.log(`   ItemEstoque:  ${totalEstoque} registros`);
  console.log(`   ReceitaItem:  ${totalReceitas} registros`);
  console.log(`\n   ℹ️  Pendentes (sem receita definida):`);
  console.log(`      POR — Papa Bagunçada`);
  console.log(`      POR — Tabla de Fríos\n`);
}

main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
