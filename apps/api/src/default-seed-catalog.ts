import type { PoolClient } from "pg";

type StarterSeed = {
  cropType: string;
  varietyName: string | null;
  family: string | null;
  supplier: string | null;
  daysToMaturity: number | null;
};

const starterSeeds: StarterSeed[] = [
  { cropType: "Arugula, Salad", varietyName: "Esmee OG", family: "Brassica", supplier: "Johnny's", daysToMaturity: 42 },
  { cropType: "Arugula, Wild", varietyName: "Match", family: "Brassica", supplier: "Smarties", daysToMaturity: 42 },
  { cropType: "Arugula, Wild", varietyName: "Strike", family: "Brassica", supplier: "Smarties", daysToMaturity: 42 },
  { cropType: "Asian Greens, Baby Bok Choy", varietyName: "Mei Qing", family: "Brassica", supplier: "Johnny's", daysToMaturity: 35 },
  { cropType: "Basil, Genovese", varietyName: "Noga Prospera OG", family: "Mint", supplier: "Johnny's", daysToMaturity: 28 },
  { cropType: "Beets, Red Storage", varietyName: "Boro OG", family: "Amaranth", supplier: "Seedway", daysToMaturity: 70 },
  { cropType: "Beets, Red Storage", varietyName: "Kamuolini 2 OG", family: "Amaranth", supplier: "Adaptive", daysToMaturity: 70 },
  { cropType: "Broccolini", varietyName: "BC1611", family: "Brassica", supplier: "Osborne", daysToMaturity: 56 },
  { cropType: "Broccoli Rabe", varietyName: "Quarantina Riccia di Sarno 40", family: "Brassica", supplier: "Salerno", daysToMaturity: 40 },
  { cropType: "Broccoli Rabe", varietyName: "Sorrento", family: "Brassica", supplier: "Osborne", daysToMaturity: null },
  { cropType: "Brussels Sprouts", varietyName: "Dagan OG", family: "Brassica", supplier: "High Mowing", daysToMaturity: 100 },
  { cropType: "Brussels Sprouts", varietyName: "Divino OG", family: "Brassica", supplier: "High Mowing", daysToMaturity: 110 },
  { cropType: "Cabbage, Baby", varietyName: "Tiara OG", family: "Brassica", supplier: "High Mowing", daysToMaturity: 63 },
  { cropType: "Cabbage, Cone", varietyName: "Caraflex OG", family: "Brassica", supplier: "Seedway", daysToMaturity: 68 },
  { cropType: "Cabbage, Late Savoy Green", varietyName: "Wirosa", family: "Brassica", supplier: "Seedway", daysToMaturity: 119 },
  { cropType: "Cabbage, Late Savoy Red", varietyName: "Deadon OG", family: "Brassica", supplier: "High Mowing", daysToMaturity: 105 },
  { cropType: "Cabbage, Napa", varietyName: "Emiko OG", family: "Brassica", supplier: "Seedway", daysToMaturity: 63 },
  { cropType: "Cabbage, Storage", varietyName: "Megaton", family: "Brassica", supplier: "High Mowing", daysToMaturity: 100 },
  { cropType: "Cabbage, Storage", varietyName: "Promise", family: "Brassica", supplier: "Johnny's", daysToMaturity: 96 },
  { cropType: "Cabbage, Storage Red", varietyName: "Ruby Perfection", family: "Brassica", supplier: "Osborne", daysToMaturity: 85 },
  { cropType: "Carrots, Orange", varietyName: "Bolero", family: "Carrot", supplier: "Johnny's", daysToMaturity: 77 },
  { cropType: "Carrots, Orange Early", varietyName: "Yaya OG", family: "Carrot", supplier: "High Mowing", daysToMaturity: 77 },
  { cropType: "Carrots, Purple", varietyName: "Purple Elite", family: "Carrot", supplier: "Johnny's", daysToMaturity: 77 },
  { cropType: "Carrots, Yellow", varietyName: "Gold Nugget", family: "Carrot", supplier: "Johnny's", daysToMaturity: 77 },
  { cropType: "Cauliflower, fall", varietyName: "Twister", family: "Brassica", supplier: "Seedway", daysToMaturity: 75 },
  { cropType: "Cauliflower, summer", varietyName: "Bermeo", family: "Brassica", supplier: "High Mowing", daysToMaturity: 70 },
  { cropType: "Cauliflower, summer", varietyName: "Fujiyama", family: "Brassica", supplier: "Johnny's", daysToMaturity: 70 },
  { cropType: "Celeriac", varietyName: "Balena OG", family: "Carrot", supplier: "High Mowing", daysToMaturity: 95 },
  { cropType: "Celery", varietyName: "Kelvin OG", family: "Carrot", supplier: "Osborne", daysToMaturity: 63 },
  { cropType: "Chicory, Puntarelle", varietyName: "Medusa OG", family: "Aster", supplier: "Smarties", daysToMaturity: 84 },
  { cropType: "Cucumber, pickling", varietyName: "Cool Customer", family: "Cucurbit", supplier: "Johnny's", daysToMaturity: null },
  { cropType: "Cucumber, slicer", varietyName: "Gateway", family: "Cucurbit", supplier: "Johnny's", daysToMaturity: 49 },
  { cropType: "Eggplant,  Asian", varietyName: "Choryoku", family: "Nightshade", supplier: "True Leaf Market", daysToMaturity: 60 },
  { cropType: "Eggplant,  Asian", varietyName: "Shinkansen", family: "Nightshade", supplier: "Johnny's", daysToMaturity: 55 },
  { cropType: "Eggplant,  Asian", varietyName: "Violet Delite", family: "Nightshade", supplier: "Osborne", daysToMaturity: null },
  { cropType: "Eggplant, Italian", varietyName: "Traviata", family: "Nightshade", supplier: "Osborne", daysToMaturity: 70 },
  { cropType: "Favas", varietyName: "Primerenca", family: "Legume", supplier: "Salerno", daysToMaturity: 63 },
  { cropType: "Fennel", varietyName: "Dragon OG", family: "Carrot", supplier: "Johnny's", daysToMaturity: 63 },
  { cropType: "Fennel", varietyName: "Preludio OG", family: "Carrot", supplier: "High Mowing", daysToMaturity: 63 },
  { cropType: "Ginger", varietyName: "Ginger OG", family: "Ginger", supplier: "Farm on Central", daysToMaturity: 150 },
  { cropType: "Herbs, Chives", varietyName: "Staro", family: "Allium", supplier: "Johnny's", daysToMaturity: 80 },
  { cropType: "Herbs, Oregano", varietyName: "Greek", family: "Mint", supplier: "Johnny's", daysToMaturity: 85 },
  { cropType: "Kale, Spigariello", varietyName: "Minestra Riccia", family: "Brassica", supplier: "Salerno", daysToMaturity: 42 },
  { cropType: "Kale, Tuscan", varietyName: "Black Jack OG", family: "Brassica", supplier: "Seedway", daysToMaturity: 42 },
  { cropType: "Leeks", varietyName: "Climber OG", family: "Allium", supplier: "High Mowing", daysToMaturity: 110 },
  { cropType: "Leeks", varietyName: "Impala OG", family: "Allium", supplier: "High Mowing", daysToMaturity: 110 },
  { cropType: "Leeks", varietyName: "Tadorna OG", family: "Allium", supplier: "High Mowing", daysToMaturity: 130 },
  { cropType: "Lettuce, Gem", varietyName: "Breen", family: "Aster", supplier: "Johnny's", daysToMaturity: null },
  { cropType: "Lettuce, Gem", varietyName: "Gatsbi", family: "Aster", supplier: "Johnny's", daysToMaturity: 52 },
  { cropType: "Lettuce, Gem", varietyName: "Newham OG", family: "Aster", supplier: "High Mowing", daysToMaturity: null },
  { cropType: "Lettuce, Gem", varietyName: "Salanova Red Gem", family: "Aster", supplier: "Johnny's", daysToMaturity: 58 },
  { cropType: "Lettuce, mini bibb", varietyName: "Kolibri", family: "Aster", supplier: "Johnny's", daysToMaturity: null },
  { cropType: "Lettuce Mix", varietyName: "Ezflor", family: "Aster", supplier: "High Mowing", daysToMaturity: null },
  { cropType: "Lettuce Mix", varietyName: "Ezpark", family: "Aster", supplier: "High Mowing", daysToMaturity: null },
  { cropType: "Lettuce Mix", varietyName: "Ezrilla", family: "Aster", supplier: "High Mowing", daysToMaturity: null },
  { cropType: "Lettuce Mix", varietyName: "Hampton", family: "Aster", supplier: "High Mowing", daysToMaturity: null },
  { cropType: "Lettuce Mix", varietyName: "Rhone", family: "Aster", supplier: "High Mowing", daysToMaturity: null },
  { cropType: "Lettuce Mix", varietyName: "Salanova Premier", family: "Aster", supplier: "Johnny's", daysToMaturity: 49 },
  { cropType: "Onions, Storage Red", varietyName: "Conservor OG", family: "Allium", supplier: "High Mowing", daysToMaturity: null },
  { cropType: "Onions, Storage Red", varietyName: "Creme Brulee", family: "Allium", supplier: "Johnny's", daysToMaturity: null },
  { cropType: "Onions, Storage Red", varietyName: "Red Carpet OG", family: "Allium", supplier: "High Mowing", daysToMaturity: 118 },
  { cropType: "Onions, Storage Red", varietyName: "Rossa di Milano OG", family: "Allium", supplier: "Johnny's", daysToMaturity: 118 },
  { cropType: "Onions, Storage Yellow", varietyName: "Scout", family: "Allium", supplier: "Johnny's", daysToMaturity: 105 },
  { cropType: "Onions, Sweet Red", varietyName: "Tropea Lunga OG", family: "Allium", supplier: "Johnny's", daysToMaturity: 105 },
  { cropType: "Onions, Sweet Yellow", varietyName: "Walla Walla", family: "Allium", supplier: "Osborne", daysToMaturity: 90 },
  { cropType: "Parsley", varietyName: "Hilmar OG", family: "Carrot", supplier: "High Mowing", daysToMaturity: 63 },
  { cropType: "Peppers, Drying Ancho", varietyName: "Bastan OG", family: "Nightshade", supplier: "High Mowing", daysToMaturity: 105 },
  { cropType: "Peppers, Drying Calabrian", varietyName: "Calabria 3", family: "Nightshade", supplier: "Salerno", daysToMaturity: 105 },
  { cropType: "Peppers, Drying Calabrian", varietyName: "Spadella", family: "Nightshade", supplier: "Salerno", daysToMaturity: 105 },
  { cropType: "Peppers, Drying Espelette", varietyName: "Basque OG", family: "Nightshade", supplier: "Uprising", daysToMaturity: 105 },
  { cropType: "Peppers, Drying Guajillo", varietyName: "El Eden", family: "Nightshade", supplier: "Sandia", daysToMaturity: 105 },
  { cropType: "Peppers, Drying Hot Paprika", varietyName: "Szegedi OG", family: "Nightshade", supplier: "Adaptive", daysToMaturity: 105 },
  { cropType: "Peppers, Drying Sweet Paprika", varietyName: "Korean Beauty Cucumber", family: "Nightshade", supplier: "True Leaf Market", daysToMaturity: 105 },
  { cropType: "Peppers, Drying Thai", varietyName: "Bottle Rocket", family: "Nightshade", supplier: "Johnny's", daysToMaturity: 105 },
  { cropType: "Peppers - Exotic-Aji", varietyName: "Aji Amarillo", family: "Nightshade", supplier: "True Love", daysToMaturity: 98 },
  { cropType: "Peppers - Exotic-Aji", varietyName: "Aji Limon", family: "Nightshade", supplier: "Sandia", daysToMaturity: 98 },
  { cropType: "Peppers - Exotic-Aji", varietyName: "Aji Rico", family: "Nightshade", supplier: "High Mowing", daysToMaturity: 98 },
  { cropType: "Peppers - Exotic-Aji", varietyName: "Sugar Rush Peach", family: "Nightshade", supplier: "Totally Tomatoes", daysToMaturity: 98 },
  { cropType: "Peppers, Green/Early", varietyName: "Charger Anaheim", family: "Nightshade", supplier: "Seedway", daysToMaturity: null },
  { cropType: "Peppers, Green/Early", varietyName: "Flaming Flare (Fresno)", family: "Nightshade", supplier: "Johnny's", daysToMaturity: null },
  { cropType: "Peppers, Green/Early", varietyName: "Hungarian Hot Wax OG", family: "Nightshade", supplier: "High Mowing", daysToMaturity: null },
  { cropType: "Peppers, Green/Early", varietyName: "Islander", family: "Nightshade", supplier: "Johnny's", daysToMaturity: null },
  { cropType: "Peppers, Green/Early", varietyName: "Jalafuego OG", family: "Nightshade", supplier: "Johnny's", daysToMaturity: null },
  { cropType: "Peppers, Green/Early", varietyName: "Katana OG", family: "Nightshade", supplier: "High Mowing", daysToMaturity: null },
  { cropType: "Peppers, Green/Early", varietyName: "Nassau", family: "Nightshade", supplier: "Johnny's", daysToMaturity: null },
  { cropType: "Peppers, Green/Early", varietyName: "Pathfinder Serrano", family: "Nightshade", supplier: "Seedway", daysToMaturity: null },
  { cropType: "Peppers, Green/Early", varietyName: "Sandia Select", family: "Nightshade", supplier: "Sandia", daysToMaturity: null },
  { cropType: "Peppers, Habanero Chocolate", varietyName: "Chocolate Habanero", family: "Nightshade", supplier: "Sandia", daysToMaturity: 105 },
  { cropType: "Peppers, Habanero Red", varietyName: "Hot Paper Lantern", family: "Nightshade", supplier: "Johnny's", daysToMaturity: 105 },
  { cropType: "Peppers, Habanero Red", varietyName: "Velociraptor", family: "Nightshade", supplier: "Johnny's", daysToMaturity: 105 },
  { cropType: "Peppers, Habanero Sriracha", varietyName: "Helios", family: "Nightshade", supplier: "Johnny's", daysToMaturity: 105 },
  { cropType: "Peppers, Hot Sriracha", varietyName: "Arapaho (Cayenne)", family: "Nightshade", supplier: "Seedway", daysToMaturity: null },
  { cropType: "Peppers, Scotch Bonnet Orange", varietyName: "Bahamian Goat", family: "Nightshade", supplier: "White Hot Peppers", daysToMaturity: 105 },
  { cropType: "Peppers, Scotch Bonnet Red", varietyName: "Red Mushroom", family: "Nightshade", supplier: "Territorial", daysToMaturity: 105 },
  { cropType: "Peppers, Scotch Bonnet Yellow", varietyName: "MOA Scotch Bonnet", family: "Nightshade", supplier: "Sandia", daysToMaturity: 105 },
  { cropType: "Peppers, Scotch Bonnet Yellow", varietyName: "Scotch Brains", family: "Nightshade", supplier: "WHP", daysToMaturity: 105 },
  { cropType: "Peppers, Seasoning", varietyName: "Aji Dulce", family: "Nightshade", supplier: "True Love", daysToMaturity: 105 },
  { cropType: "Peppers, Seasoning", varietyName: "Aji Dulce #2", family: "Nightshade", supplier: "Totally Tomatoes", daysToMaturity: 105 },
  { cropType: "Peppers, Seasoning", varietyName: "Habanada", family: "Nightshade", supplier: "High Mowing", daysToMaturity: 105 },
  { cropType: "Peppers, Seasoning", varietyName: "Roulette", family: "Nightshade", supplier: "Hoss", daysToMaturity: 105 },
  { cropType: "Peppers, Seasoning", varietyName: "Tobago Seasoning", family: "Nightshade", supplier: "Baker Creek", daysToMaturity: 105 },
  { cropType: "Peppers, Seasoning", varietyName: "Trinidad Perfume", family: "Nightshade", supplier: "Bohica pepper hut", daysToMaturity: 105 },
  { cropType: "Peppers, Superhot", varietyName: "7 Pot Douglah", family: "Nightshade", supplier: "WHP", daysToMaturity: null },
  { cropType: "Peppers, Superhot", varietyName: "7 Pot Primo", family: "Nightshade", supplier: "WHP", daysToMaturity: null },
  { cropType: "Peppers, Superhot", varietyName: "Apocalypse Scorpion", family: "Nightshade", supplier: "WHP", daysToMaturity: null },
  { cropType: "Peppers, Superhot", varietyName: "Borg 9 Yellow", family: "Nightshade", supplier: "WHP", daysToMaturity: null },
  { cropType: "Peppers, Superhot", varietyName: "Brain Strain", family: "Nightshade", supplier: "WHP", daysToMaturity: null },
  { cropType: "Peppers, Superhot", varietyName: "Brain Strain Yellow", family: "Nightshade", supplier: "WHP", daysToMaturity: null },
  { cropType: "Peppers, Superhot", varietyName: "California Reaper", family: "Nightshade", supplier: "WHP", daysToMaturity: null },
  { cropType: "Peppers, Superhot", varietyName: "Chocolate Apocalypse Scorpion", family: "Nightshade", supplier: "WHP", daysToMaturity: null },
  { cropType: "Peppers, Superhot", varietyName: "Chocolate Bhut Jolokia", family: "Nightshade", supplier: "WHP", daysToMaturity: null },
  { cropType: "Peppers, Superhot", varietyName: "Dragon's Breath", family: "Nightshade", supplier: "Bohica pepper hut", daysToMaturity: null },
  { cropType: "Peppers, Superhot", varietyName: "Jay's Peach Ghost Scorpion", family: "Nightshade", supplier: "WHP", daysToMaturity: null },
  { cropType: "Peppers, Superhot", varietyName: "Reaper x Moruga", family: "Nightshade", supplier: "WHP", daysToMaturity: null },
  { cropType: "Peppers, Superhot", varietyName: "Saved KG varieties", family: "Nightshade", supplier: "KG", daysToMaturity: 105 },
  { cropType: "Peppers, Sweet", varietyName: "Cornito Arancia OG", family: "Nightshade", supplier: "Johnny's", daysToMaturity: 91 },
  { cropType: "Peppers, Sweet", varietyName: "Cornito Giallo OG", family: "Nightshade", supplier: "Johnny's", daysToMaturity: 91 },
  { cropType: "Peppers, Sweet", varietyName: "Early Perfect Italian", family: "Nightshade", supplier: "Wild Garden", daysToMaturity: 91 },
  { cropType: "Peppers, Sweet", varietyName: "Jimmy Nardello OG", family: "Nightshade", supplier: "Fedco", daysToMaturity: 91 },
  { cropType: "Peppers, Sweet Sriracha", varietyName: "Oranos OG", family: "Nightshade", supplier: "High Mowing", daysToMaturity: 91 },
  { cropType: "Potatoes, Mid", varietyName: "Nicola", family: "Nightshade", supplier: "Maine Potato Lady", daysToMaturity: 98 },
  { cropType: "Radicchio, Castelfranco early", varietyName: "Mirabella OG", family: "Aster", supplier: "Smarties", daysToMaturity: 58 },
  { cropType: "Radicchio, Castelfranco late", varietyName: "Lentiggini OG", family: "Aster", supplier: "Smarties", daysToMaturity: 103 },
  { cropType: "Radicchio, Castelfranco mid", varietyName: "Beatrice OG", family: "Aster", supplier: "Smarties", daysToMaturity: 83 },
  { cropType: "Radicchio, Castelfranco mid", varietyName: "Lucrezia", family: "Aster", supplier: "Blumen", daysToMaturity: 84 },
  { cropType: "Radicchio, chioggia early", varietyName: "Stromboli OG", family: "Aster", supplier: "Smarties", daysToMaturity: 58 },
  { cropType: "Radicchio, chioggia, late", varietyName: "Santa Helena OG", family: "Aster", supplier: "Smarties", daysToMaturity: 103 },
  { cropType: "Radicchio, chioggia mid", varietyName: "Leonardo OG", family: "Aster", supplier: "High Mowing", daysToMaturity: 78 },
  { cropType: "Radicchio, Chioggia mid", varietyName: "Hekla OG", family: "Aster", supplier: "Smarties", daysToMaturity: 83 },
  { cropType: "Radicchio, Chioggia yellow", varietyName: "Fiocco Cicoria Bianca", family: "Aster", supplier: "Smarties", daysToMaturity: null },
  { cropType: "Radicchio, Pink", varietyName: "Jolanda OG", family: "Aster", supplier: "Smarties", daysToMaturity: 113 },
  { cropType: "Radicchio, Pink", varietyName: "Stella Rosa", family: "Aster", supplier: "Johnny's", daysToMaturity: 103 },
  { cropType: "Radicchio, Tardivo late", varietyName: "Sile Tardiva", family: "Aster", supplier: "Blumen", daysToMaturity: 112 },
  { cropType: "Radicchio, Tardivo mid", varietyName: "Sile Precoce", family: "Aster", supplier: "Osborne", daysToMaturity: 105 },
  { cropType: "Radicchio, Treviso early", varietyName: "Lava", family: "Aster", supplier: "Smarties", daysToMaturity: 58 },
  { cropType: "Radicchio, Treviso, late", varietyName: "Pacifico OG", family: "Aster", supplier: "Smarties", daysToMaturity: 103 },
  { cropType: "Radicchio, Treviso mid", varietyName: "Regina Rossa OG", family: "Aster", supplier: "Smarties", daysToMaturity: 83 },
  { cropType: "Radicchio, Treviso mid", varietyName: "Sangria OG", family: "Aster", supplier: "Smarties", daysToMaturity: null },
  { cropType: "Radicchio, variegated early", varietyName: "Sorgente", family: "Aster", supplier: "Smarties", daysToMaturity: 70 },
  { cropType: "Radicchio, variegated late late", varietyName: "Acquerello", family: "Aster", supplier: "Smarties", daysToMaturity: 143 },
  { cropType: "Radicchio, variegated mid", varietyName: "Adige Medio/Precoce", family: "Aster", supplier: "Blumen", daysToMaturity: 70 },
  { cropType: "Radicchio, variegated mid", varietyName: "Delta", family: "Aster", supplier: "Smarties", daysToMaturity: 83 },
  { cropType: "Radicchio, variegated mid", varietyName: "Fonte", family: "Aster", supplier: "Smarties", daysToMaturity: null },
  { cropType: "Radicchio, Verona late", varietyName: "Giulietta", family: "Aster", supplier: "Osborne", daysToMaturity: 70 },
  { cropType: "Radicchio, Verona late late", varietyName: "Bandarossa", family: "Aster", supplier: "Smarties", daysToMaturity: 70 },
  { cropType: "Radicchio, Verona mid", varietyName: "Romeo OG", family: "Aster", supplier: "Smarties", daysToMaturity: 84 },
  { cropType: "Radicchio, Yellow Verona", varietyName: "Yellowstone OG", family: "Aster", supplier: "Smarties", daysToMaturity: 98 },
  { cropType: "Radish, green Diakon", varietyName: "Green Luobo", family: "Brassica", supplier: "Johnnys", daysToMaturity: 70 },
  { cropType: "Radish, Ponytail", varietyName: "Passion Altari", family: "Brassica", supplier: "True Leaf Market", daysToMaturity: 60 },
  { cropType: "Radish, Purple daikon", varietyName: "KN-Bravo", family: "Brassica", supplier: "Johnnys", daysToMaturity: 70 },
  { cropType: "Radish, Red daikon", varietyName: "Red King", family: "Brassica", supplier: "Johnnys", daysToMaturity: 70 },
  { cropType: "Radish, Watermelon", varietyName: "Red Meat", family: "Brassica", supplier: "Johnnys", daysToMaturity: null },
  { cropType: "Radish, White Daikon", varietyName: "Alpine", family: "Brassica", supplier: "Johnnys", daysToMaturity: 70 },
  { cropType: "Rutabaga", varietyName: "Hellenor OG", family: "Brassica", supplier: "Johnny's", daysToMaturity: 90 },
  { cropType: "Scallion", varietyName: "Ishikura", family: "Allium", supplier: "True Leaf Market", daysToMaturity: 56 },
  { cropType: "Spicy Mix", varietyName: "Mixed Greens", family: "Brassica", supplier: "Johnny's", daysToMaturity: 42 },
  { cropType: "Spinach", varietyName: "Hammerhead", family: "Amaranth", supplier: "Johnny's", daysToMaturity: 42 },
  { cropType: "Spinach", varietyName: "Space", family: "Amaranth", supplier: "Johnny's", daysToMaturity: 42 },
  { cropType: "Summer Squash", varietyName: "Golden Glory", family: "Cucurbit", supplier: "Johnny's", daysToMaturity: null },
  { cropType: "Summer Squash", varietyName: "Mexicana OG", family: "Cucurbit", supplier: "Johnny's", daysToMaturity: null },
  { cropType: "Summer Squash", varietyName: "Safari", family: "Cucurbit", supplier: "Johnny's", daysToMaturity: null },
  { cropType: "Summer Squash", varietyName: "Tempest", family: "Cucurbit", supplier: "Johnny's", daysToMaturity: null },
  { cropType: "Summer Squash", varietyName: "Zephyr", family: "Cucurbit", supplier: "Johnny's", daysToMaturity: null },
  { cropType: "Summer Squash, Zucchini", varietyName: "Dunja OG", family: "Cucurbit", supplier: "Johnny's", daysToMaturity: 35 },
  { cropType: "Tomatillo", varietyName: "Clemente", family: "Nightshade", supplier: "Seedway", daysToMaturity: null },
  { cropType: "Tomatillo", varietyName: "Tamayo", family: "Nightshade", supplier: "Seedway", daysToMaturity: 70 },
  { cropType: "Tomatoes, cherry", varietyName: "Chocolate sprinkles", family: "Nightshade", supplier: "Totally Tomatoes", daysToMaturity: 70 },
  { cropType: "Tomatoes, cherry", varietyName: "Indigo Kumquat", family: "Nightshade", supplier: "Johnny's", daysToMaturity: 70 },
  { cropType: "Tomatoes, cherry", varietyName: "Mochi", family: "Nightshade", supplier: "Johnny's", daysToMaturity: 70 },
  { cropType: "Tomatoes, cherry", varietyName: "Sakura", family: "Nightshade", supplier: "Johnny's", daysToMaturity: 70 },
  { cropType: "Tomatoes, cherry", varietyName: "Sun Gold", family: "Nightshade", supplier: "Fedco", daysToMaturity: 70 },
  { cropType: "Tomatoes, cherry", varietyName: "Sweet Treats", family: "Nightshade", supplier: "Osborne", daysToMaturity: 70 },
  { cropType: "Tomatoes, cherry", varietyName: "White Cherry", family: "Nightshade", supplier: "Johnny's", daysToMaturity: 70 },
  { cropType: "Tomatoes, cherry", varietyName: "Yellow Mini", family: "Nightshade", supplier: "Johnny's", daysToMaturity: 70 },
  { cropType: "Tomatoes, field plum", varietyName: "Bengala", family: "Nightshade", supplier: "Salerno", daysToMaturity: 77 },
  { cropType: "Tomatoes, field plum", varietyName: "Granadero", family: "Nightshade", supplier: "Johnny's", daysToMaturity: 84 },
  { cropType: "Tomatoes, field plum", varietyName: "P09312 (Cento)", family: "Nightshade", supplier: "Salerno", daysToMaturity: 77 },
  { cropType: "Tomatoes, field plum", varietyName: "Tiren", family: "Nightshade", supplier: "Johnny's", daysToMaturity: 84 },
  { cropType: "Tomatoes, greenhouse", varietyName: "Abigail", family: "Nightshade", supplier: "Johnny's", daysToMaturity: 77 },
  { cropType: "Tomatoes, greenhouse", varietyName: "Beorange", family: "Nightshade", supplier: "Johnny's", daysToMaturity: 77 },
  { cropType: "Tomatoes, greenhouse", varietyName: "Bonbolya", family: "Nightshade", supplier: "Johnny's", daysToMaturity: 77 },
  { cropType: "Tomatoes, greenhouse", varietyName: "Ginfiz", family: "Nightshade", supplier: "Johnny's", daysToMaturity: 77 },
  { cropType: "Tomatoes, greenhouse", varietyName: "Grandma's Pick", family: "Nightshade", supplier: "Territorial", daysToMaturity: 77 },
  { cropType: "Tomatoes, greenhouse", varietyName: "Hot Streak", family: "Nightshade", supplier: "Johnny's", daysToMaturity: 77 },
  { cropType: "Tomatoes, greenhouse", varietyName: "Marbonne", family: "Nightshade", supplier: "Johnny's", daysToMaturity: 77 },
  { cropType: "Tomatoes, greenhouse", varietyName: "Marnero", family: "Nightshade", supplier: "Johnny's", daysToMaturity: 77 },
  { cropType: "Tomatoes, greenhouse", varietyName: "Marnouar", family: "Nightshade", supplier: "Johnny's", daysToMaturity: 77 },
  { cropType: "Tomatoes, greenhouse plum", varietyName: "Gilbertie", family: "Nightshade", supplier: "High Mowing", daysToMaturity: 77 },
  { cropType: "Tomatoes, greenhouse plum", varietyName: "Pozzano", family: "Nightshade", supplier: "Johnny's", daysToMaturity: 77 },
  { cropType: "Tomatoes, red greenhouse", varietyName: "BHN 589", family: "Nightshade", supplier: "Johnny's", daysToMaturity: 77 },
];

async function upsertStarterCrop(client: PoolClient, cropType: string) {
  const result = await client.query<{ id: number }>(
    `
      insert into crops (name)
      values ($1)
      on conflict (name) do update set name = excluded.name
      returning id
    `,
    [cropType]
  );
  return result.rows[0].id;
}

async function upsertStarterVariety(client: PoolClient, cropId: number, varietyName: string | null) {
  if (!varietyName) {
    return null;
  }
  const result = await client.query<{ id: number }>(
    `
      insert into varieties (crop_id, name)
      values ($1, $2)
      on conflict (crop_id, name) do update set name = excluded.name
      returning id
    `,
    [cropId, varietyName]
  );
  return result.rows[0].id;
}

export async function seedStarterSeedCatalog(client: PoolClient, farmId: number) {
  let inserted = 0;
  for (const seed of starterSeeds) {
    const existing = await client.query<{ id: number }>(
      `
        select id
        from seed_items
        where farm_id = $1
          and lower(crop_type) = lower($2)
          and lower(coalesce(variety_name, '')) = lower($3)
          and lower(coalesce(supplier, '')) = lower($4)
        limit 1
      `,
      [farmId, seed.cropType, seed.varietyName ?? '', seed.supplier ?? '']
    );
    if (existing.rows[0]) {
      continue;
    }

    const cropId = await upsertStarterCrop(client, seed.cropType);
    const varietyId = await upsertStarterVariety(client, cropId, seed.varietyName);
    await client.query(
      `
        insert into seed_items (
          farm_id, crop_id, variety_id, family, crop_type, variety_name, supplier, days_to_maturity, stock_quantity
        )
        values ($1, $2, $3, $4, $5, $6, $7, $8, null)
      `,
      [farmId, cropId, varietyId, seed.family, seed.cropType, seed.varietyName, seed.supplier, seed.daysToMaturity]
    );
    inserted += 1;
  }
  return inserted;
}
