// One-off bulk import: extracts structured recipe data from a large list of
// URLs and files each one directly into the Recipe Bank — no per-item
// review (explicitly requested for this batch, given the volume). Paces
// requests per-domain so a domain with many URLs in the list (bbcgoodfood.com
// here) isn't hammered. Skips anything that fails to parse cleanly rather
// than stopping the whole run, and writes a running summary to
// scripts/.data/ after every item so progress survives an interruption.
//
// Run with: npx tsx scripts/importRecipeUrls.ts
import fs from "node:fs/promises";
import path from "node:path";
import { loadEnv } from "vite";
import { createNotionClient } from "../server/notion/client.js";
import { loadNotionEnv } from "../server/notion/env.js";
import { NotionRepo } from "../server/notion/queries.js";
import type { MealType } from "../server/notion/schema.js";
import { loadLlmEnv } from "../server/llm/env.js";
import { extractRecipeFromUrl } from "../server/recipes/urlExtract.js";

const URLS = [
  "http://allrecipes.co.uk/recipe/40346/amazing-soft-and-chewy-chocolate-chip-cookies.aspx",
  "https://app.deliciouslyella.com/recipe/N8b94917ewosKua66",
  "https://app.deliciouslyella.com/recipe/Nf3FkAxKem8HxouD9",
  "https://app.deliciouslyella.com/recipe/imSEzvsPJbhUHELv9",
  "https://app.deliciouslyella.com/recipe/mTA3Rz9N39JpGotv8",
  "https://bakerbynature.com/pan-seared-cod-in-white-wine-tomato-basil-sauce/",
  "https://baranbakery.com/how-to-make-a-macaron-cake/#mv-creation-196-jtr",
  "https://cookieandkate.com/how-to-make-tzatziki/",
  "https://cookkitchen.familyfreshrecipes.com/2025/01/03/one-pan-garlic-herb-chicken-with-potatoes-green-beans/",
  "https://downshiftology.com/recipes/baked-cod/#wprm-recipe-container-44975",
  "https://feelgoodfoodie.net/recipe/white-bean-soup/#wprm-recipe-container-8825",
  "https://food.netmums.com/meal-planners/meal-plans-with-a-slowcooker/im-a-parenting-editor-these-are-the-5-slow-cooker-dinners-i-keep-making-for-my-kids",
  "https://foodwithfeeling.com/mushroom-and-pea-risotto/",
  "https://hotcooking.co.uk/recipes/jamie-oliver-30-minute-meals-tasty-crusted-cod",
  "https://hotcooking.co.uk/recipes/lemon-cod-and-basil-bean-mash",
  "https://iheartvegetables.com/crispy-tofu-stir-fry/",
  "https://joyfoodsunshine.com/overnight-oats-yogurt/",
  "https://kaynutrition.com/wild-rice-vegetable-soup/",
  "https://lianaskitchen.co.uk/sweet-potato-and-lentil-soup/",
  "https://lucyandlentils.co.uk/recipe/dinner/easy-tofu-ramen",
  "https://miarecipes.uplodati.com/2026/01/18/crustless-spinach-onion-feta-tortilla/",
  "https://minimalistbaker.com/sweet-potato-chickpea-buddha-bowl/",
  "https://munchmealsbyjanet.com/2021/01/31/vegan-stir-fry-noodles-with-crispy-tofu/#recipe",
  "https://mygoodnesskitchen.com/walk-away-chickpea-tomato-and-spinach-curry-vegan/#recipe",
  "https://naturallieplantbased.com/chickpea-soup/",
  "https://ohmyveggies.com/thai-banana-in-coconut-milk/",
  "https://plantbasedonabudget.com/coconut-curry/#wprm-recipe-container-18390",
  "https://realfood.tesco.com/curatedlist/slow-cooker-meal-prep-bags.html",
  "https://realfood.tesco.com/gallery/top-fathers-day-baking-recipes.html",
  "https://realfood.tesco.com/recipes/chicken-in-creamy-mushroom-sauce.html",
  "https://realfood.tesco.com/recipes/chilli-prawn-stir-fry.html",
  "https://realfood.tesco.com/recipes/healthy-fish-and-chips.html",
  "https://realfood.tesco.com/recipes/margherita-pizza.html",
  "https://realfood.tesco.com/recipes/mushroom-eggy-bread.html",
  "https://realfood.tesco.com/recipes/ratatouille-pasta-bake.html",
  "https://realfood.tesco.com/recipes/roasted-squash-and-goats-cheese-fusilli.html",
  "https://realfood.tesco.com/recipes/toad-in-the-hole-with-onion-gravy.html",
  "https://realfood.tesco.com/recipes/vegan-spaghetti-bolognese.html",
  "https://realfood.tesco.com/recipes/vegetarian-lasagne.html",
  "https://simplehomeedit.com/recipe/creamy-chicken-and-leek-pot-pie/",
  "https://simplehomeedit.com/recipe/marry-me-chicken-risoni-orzo/",
  "https://simplehomeedit.com/recipe/quick-coconut-chicken-curry/",
  "https://somebodyfeedseb.com/courgette-and-lime-cake/#recipe",
  "https://sugargeekshow.com/recipe/french-almond-macaron-recipe/",
  "https://tastefullyvikkie.com/slimming-world-syn-free-kale-soup-recipe-soup-maker-pan-friendly/",
  "https://tasty.co/recipe/camembert-bread-bowl",
  "https://tasty.co/recipe/slow-cooker-butter-chicken",
  "https://thebigmansworld.com/tuscan-white-bean-soup/",
  "https://thehappyfoodie.co.uk/recipes/sweet-potato-chickpea-and-spinach-coconut-curry",
  "https://theinspiredhome.com/articles/hot-drinks-for-when-you-have-a-cold/",
  "https://www.allrecipes.com/recipe/24712/ginger-veggie-stir-fry/",
  "https://www.allrecipes.com/recipe/265472/vegan-sweet-potato-chickpea-curry/",
  "https://www.bbc.co.uk/food/collections/make-ahead_breakfast",
  "https://www.bbc.co.uk/food/recipes/baked_salmon_00289",
  "https://www.bbc.co.uk/food/recipes/buttermilk_pancakes_10390",
  "https://www.bbc.co.uk/food/recipes/chicken_in_a_creamy_84614",
  "https://www.bbc.co.uk/food/recipes/creamy_chicken_ham_and_03877",
  "https://www.bbc.co.uk/food/recipes/creamypastawithsalmo_79948",
  "https://www.bbc.co.uk/food/recipes/greek_salad_16407",
  "https://www.bbc.co.uk/food/recipes/pennewithhaloumiandc_92783",
  "https://www.bbc.co.uk/food/recipes/pesto_pasta_salad_72323",
  "https://www.bbc.co.uk/food/recipes/puy_lentil_bolognaise_40407",
  "https://www.bbc.co.uk/food/recipes/red_pepper_and_aubergine_84745/amp",
  "https://www.bbc.co.uk/food/recipes/roasted_summer_vegetable_82276",
  "https://www.bbc.co.uk/food/recipes/slow_cooker_tuscan_27704",
  "https://www.bbc.co.uk/food/recipes/spaghetti_and_meatballs_69603",
  "https://www.bbc.co.uk/food/recipes/thaiinspirednoodleso_92377",
  "https://www.bbc.co.uk/food/recipes/vegetable_pasta_bake_15082",
  "https://www.bbc.co.uk/food/recipes/watercress_and_pea_soup_72980",
  "https://www.bbcgoodfood.com/premium/best-ever-asparagus-pea-risotto",
  "https://www.bbcgoodfood.com/premium/honey-mustard-chicken",
  "https://www.bbcgoodfood.com/recipes/1940681/sausage-and-bean-casserole-",
  "https://www.bbcgoodfood.com/recipes/3327/cauliflower-cheese-soup",
  "https://www.bbcgoodfood.com/recipes/5-day-bolognese",
  "https://www.bbcgoodfood.com/recipes/9020/best-yorkshire-puddings",
  "https://www.bbcgoodfood.com/recipes/akoori-indian-scrambled-eggs",
  "https://www.bbcgoodfood.com/recipes/american-pancakes",
  "https://www.bbcgoodfood.com/recipes/apple-linseed-porridge",
  "https://www.bbcgoodfood.com/recipes/asian-tofu-stir-fried-noodles-pak-choi-sugar-snap-peas",
  "https://www.bbcgoodfood.com/recipes/aubergine-chickpea-stew",
  "https://www.bbcgoodfood.com/recipes/best-ever-chunky-guacamole",
  "https://www.bbcgoodfood.com/recipes/best-ever-macaroni-cheese-recipe",
  "https://www.bbcgoodfood.com/recipes/breakfast-egg-wraps",
  "https://www.bbcgoodfood.com/recipes/broccoli-stilton-soup",
  "https://www.bbcgoodfood.com/recipes/buttermilk-fried-chicken",
  "https://www.bbcgoodfood.com/recipes/buttermilk-pancakes-maple-apples-pecans",
  "https://www.bbcgoodfood.com/recipes/caponata-pasta",
  "https://www.bbcgoodfood.com/recipes/caramel-sauce",
  "https://www.bbcgoodfood.com/recipes/caramelised-onion-quiche-cheddar-bacon",
  "https://www.bbcgoodfood.com/recipes/carrot-coriander-soup",
  "https://www.bbcgoodfood.com/recipes/cassies-chai-tea",
  "https://www.bbcgoodfood.com/recipes/cheese-sauce",
  "https://www.bbcgoodfood.com/recipes/chicken-parmo",
  "https://www.bbcgoodfood.com/recipes/chicken-schnitzel-coleslaw",
  "https://www.bbcgoodfood.com/recipes/chilli-con-carne-recipe",
  "https://www.bbcgoodfood.com/recipes/classic-lasagne",
  "https://www.bbcgoodfood.com/recipes/coconut-fish-curry-traybake",
  "https://www.bbcgoodfood.com/recipes/coconut-squash-dhansak",
  "https://www.bbcgoodfood.com/recipes/cod-smashed-celeriac",
  "https://www.bbcgoodfood.com/recipes/cottage-pie",
  "https://www.bbcgoodfood.com/recipes/courgette-lime-cake",
  "https://www.bbcgoodfood.com/recipes/creamy-pesto-kale-pasta",
  "https://www.bbcgoodfood.com/recipes/creamy-salmon-pasta",
  "https://www.bbcgoodfood.com/recipes/crispy-greek-style-pie",
  "https://www.bbcgoodfood.com/recipes/crispy-grilled-feta-saucy-butter-beans",
  "https://www.bbcgoodfood.com/recipes/crispy-traybake-stuffing",
  "https://www.bbcgoodfood.com/recipes/cupcakes",
  "https://www.bbcgoodfood.com/recipes/curried-mango-chickpea-pot",
  "https://www.bbcgoodfood.com/recipes/easy-baked-tomato-risotto",
  "https://www.bbcgoodfood.com/recipes/easy-pancakes",
  "https://www.bbcgoodfood.com/recipes/easy-protein-pancakes",
  "https://www.bbcgoodfood.com/recipes/edd-kimbers-bakewell-ombre-cake",
  "https://www.bbcgoodfood.com/recipes/eggs-benedict-smoked-salmon-chives",
  "https://www.bbcgoodfood.com/recipes/family-breakfast-station",
  "https://www.bbcgoodfood.com/recipes/funfetti-cake",
  "https://www.bbcgoodfood.com/recipes/fuss-free-lasagne",
  "https://www.bbcgoodfood.com/recipes/good-you-granola",
  "https://www.bbcgoodfood.com/recipes/halloween-pumpkin-cake",
  "https://www.bbcgoodfood.com/recipes/hash-browns",
  "https://www.bbcgoodfood.com/recipes/healthy-chocolate-milk",
  "https://www.bbcgoodfood.com/recipes/herby-rice-roasted-veg-chickpeas-halloumi",
  "https://www.bbcgoodfood.com/recipes/homemade-buttermilk",
  "https://www.bbcgoodfood.com/recipes/honey-orange-roast-sea-bass-lentils",
  "https://www.bbcgoodfood.com/recipes/hot-cross-buns-2",
  "https://www.bbcgoodfood.com/recipes/japanese-ramen-noodle-soup",
  "https://www.bbcgoodfood.com/recipes/jerk-cod-creamed-corn/amp",
  "https://www.bbcgoodfood.com/recipes/keep-it-simple-kedgeree",
  "https://www.bbcgoodfood.com/recipes/leek-bacon-potato-soup",
  "https://www.bbcgoodfood.com/recipes/leek-pea-watercress-soup",
  "https://www.bbcgoodfood.com/recipes/lemon-drizzle-cake",
  "https://www.bbcgoodfood.com/recipes/lemony-tuna-tomato-caper-one-pot-pasta",
  "https://www.bbcgoodfood.com/recipes/miso-salmon-ginger-noodles",
  "https://www.bbcgoodfood.com/recipes/mochi-ice-cream",
  "https://www.bbcgoodfood.com/recipes/nacho-cheese-sauce",
  "https://www.bbcgoodfood.com/recipes/ombre-mermaid-cake",
  "https://www.bbcgoodfood.com/recipes/one-pot-cabbage-beans-white-fish",
  "https://www.bbcgoodfood.com/recipes/parsnip-hash-browns",
  "https://www.bbcgoodfood.com/recipes/pea-leek-open-lasagne",
  "https://www.bbcgoodfood.com/recipes/pea-risotto",
  "https://www.bbcgoodfood.com/recipes/penang-prawn-pineapple-curry",
  "https://www.bbcgoodfood.com/recipes/pizza-margherita-4-easy-steps",
  "https://www.bbcgoodfood.com/recipes/poached-eggs-broccoli-tomatoes-wholemeal-flatbread",
  "https://www.bbcgoodfood.com/recipes/prawn-butternut-mango-curry",
  "https://www.bbcgoodfood.com/recipes/puff-pastry",
  "https://www.bbcgoodfood.com/recipes/pumpkin-curry-chickpeas",
  "https://www.bbcgoodfood.com/recipes/radish-burrata-nasturtium-salad-with-quinoa",
  "https://www.bbcgoodfood.com/recipes/refried-bean-quesadillas",
  "https://www.bbcgoodfood.com/recipes/roast-chicken-lemon-rosemary-roots",
  "https://www.bbcgoodfood.com/recipes/roast-chicken-soup",
  "https://www.bbcgoodfood.com/recipes/roasted-vegetables",
  "https://www.bbcgoodfood.com/recipes/salmon-greens-creme-fraiche",
  "https://www.bbcgoodfood.com/recipes/salmon-risotto",
  "https://www.bbcgoodfood.com/recipes/saras-chilli-con-carne",
  "https://www.bbcgoodfood.com/recipes/sausage-butter-bean-stew",
  "https://www.bbcgoodfood.com/recipes/sausage-ragu",
  "https://www.bbcgoodfood.com/recipes/sausage-white-bean-casserole",
  "https://www.bbcgoodfood.com/recipes/sausage-white-bean-casserole/amp",
  "https://www.bbcgoodfood.com/recipes/school-days-sprinkle-sponge",
  "https://www.bbcgoodfood.com/recipes/silky-celeriac-soup-smoked-haddock",
  "https://www.bbcgoodfood.com/recipes/slow-cooker-chicken-korma",
  "https://www.bbcgoodfood.com/recipes/slow-cooker-chicken-tikka-masala",
  "https://www.bbcgoodfood.com/recipes/slow-cooker-mac-n-cheese",
  "https://www.bbcgoodfood.com/recipes/slow-cooker-meatballs",
  "https://www.bbcgoodfood.com/recipes/slow-cooker-sausage-casserole",
  "https://www.bbcgoodfood.com/recipes/smoky-hake-beans-greens",
  "https://www.bbcgoodfood.com/recipes/soup-maker-pea-ham-soup",
  "https://www.bbcgoodfood.com/recipes/spanish-meatball-butter-bean-stew",
  "https://www.bbcgoodfood.com/recipes/spanish-tortilla",
  "https://www.bbcgoodfood.com/recipes/spiced-carrot-apple-muffins",
  "https://www.bbcgoodfood.com/recipes/spiced-carrot-lentil-soup",
  "https://www.bbcgoodfood.com/recipes/spiced-halloumi-pineapple-burger-zingy-slaw",
  "https://www.bbcgoodfood.com/recipes/spicy-cauliflower-halloumi-rice",
  "https://www.bbcgoodfood.com/recipes/spicy-tuna-cottage-cheese-jacket",
  "https://www.bbcgoodfood.com/recipes/strawberry-green-goddess-smoothie",
  "https://www.bbcgoodfood.com/recipes/summer-berry-cake-rose-geranium-cream",
  "https://www.bbcgoodfood.com/recipes/swedish-smoked-salmon-spinach-gratin",
  "https://www.bbcgoodfood.com/recipes/sweet-potato-lentil-soup",
  "https://www.bbcgoodfood.com/recipes/sweet-potato-topped-cottage-pie",
  "https://www.bbcgoodfood.com/recipes/sweet-sour-tofu",
  "https://www.bbcgoodfood.com/recipes/teriyaki-sauce",
  "https://www.bbcgoodfood.com/recipes/thai-prawn-ginger-spring-onion-stir-fry",
  "https://www.bbcgoodfood.com/recipes/tofu-greens-cashew-stir-fry",
  "https://www.bbcgoodfood.com/recipes/tofu-stir-fry",
  "https://www.bbcgoodfood.com/recipes/tofu-stir-fry/amp",
  "https://www.bbcgoodfood.com/recipes/tuna-melt-pizza-baguettes",
  "https://www.bbcgoodfood.com/recipes/two-minute-breakfast-smoothie",
  "https://www.bbcgoodfood.com/recipes/vegan-kale-pesto-pasta",
  "https://www.bbcgoodfood.com/recipes/vegetable-curry-crowd",
  "https://www.bbcgoodfood.com/recipes/vegetarian-bolognese",
  "https://www.bbcgoodfood.com/recipes/vegetarian-casserole",
  "https://www.bbcgoodfood.com/recipes/veggie-shepherds-pie-sweet-potato-mash",
  "https://www.bbcgoodfood.com/recipes/zesty-haddock-crushed-potatoes-peas",
  "https://www.breakfastcriminals.com/ceremonial-cacao-recipe-heart-opening-rose-elixir/",
  "https://www.budgetbytes.com/creamy-tomato-spinach-pasta/",
  "https://www.butcherbakerblog.com/2010/03/01/jelly-fluff/",
  "https://www.chalkstreamfoods.co.uk/blogs/recipes/trout-asparagus-tagliatelle",
  "https://www.coop.co.uk/recipes/butternut-squash-and-sweet-potato-curry",
  "https://www.coop.co.uk/recipes/mediterranean-chicken-traybake",
  "https://www.coop.co.uk/recipes/sweet-potato-cottage-pie",
  "https://www.deliciouseveryday.com/celeriac-soup/",
  "https://www.deliciousmagazine.co.uk/recipes/cod-with-garlic-sweet-potato-mash-and-lemon-spinach/",
  "https://www.deliciousmagazine.co.uk/recipes/vegetable-fritters-with-poached-eggs/",
  "https://www.delish.com/uk/cooking/recipes/a29870964/tofu-stir-fry-recipe/",
  "https://www.delishknowledge.com/slow-cooker-butternut-squash-curry-recipe/",
  "https://www.easypeasyfoodie.com/sweet-potato-red-lentil-soup-vegan/",
  "https://www.eatingwell.com/high-protein-apple-peanut-butter-overnight-oats-11784430",
  "https://www.eatwell101.com/creamy-garlic-tuscan-salmon-recipe",
  "https://www.feastingathome.com/pan-seared-halibut-with-lemony-zucchini-noodles/",
  "https://www.goodhousekeeping.com/uk/food/recipes/a537061/slow-cooker-beef-stew-with-dumplings/",
  "https://www.goodhousekeeping.com/uk/food/recipes/a578453/beef-casserole-slow-cooker/",
  "https://www.goodto.com/recipes/prawn-and-squash-curry",
  "https://www.goodtoknow.co.uk/recipes/535183/hairy-biker-s-cottage-pie",
  "https://www.goodtoknow.co.uk/recipes/hairy-biker-s-cottage-pie",
  "https://www.goodtoknow.co.uk/recipes/prawn-and-squash-curry",
  "https://www.goodtoknow.co.uk/recipes/spiced-winter-roots-soup",
  "https://www.google.co.uk/amp/s/www.bbcgoodfood.com/recipes/slow-cooker-sausage-casserole/amp",
  "https://www.google.com/amp/s/bucksoxon.muddystilettos.co.uk/home/dr-rupy-aujla-one-pot/amp/",
  "https://www.google.com/amp/s/www.bbcgoodfood.com/recipes/775643/cottage-pie%3famp",
  "https://www.google.com/amp/s/www.bbcgoodfood.com/recipes/best-spaghetti-bolognese-recipe/amp",
  "https://www.google.com/amp/s/www.bbcgoodfood.com/recipes/smashed-mini-jackets/amp",
  "https://www.google.com/amp/s/www.bbcgoodfood.com/recipes/sweet-potato-lentil-soup/amp",
  "https://www.google.com/amp/s/www.deliaonline.com/recipes/collections/root-vegetables/leek-onion-and-potato-soup%3famp",
  "https://www.gooutdoors.co.uk/camping-recipes",
  "https://www.gousto.co.uk/cookbook/vegetarian-recipes/tuscan-panzanella-salad",
  "https://www.homemademastery.com/mediterranean-chicken-wraps/",
  "https://www.indianhealthyrecipes.com/paneer-butter-masala-restaurant-style/",
  "https://www.jamieoliver.com/recipes/beef-recipes/spaghetti-bolognese/",
  "https://www.jamieoliver.com/recipes/eggs-recipes/brilliant-breakfast-waffles/",
  "https://www.jamieoliver.com/recipes/fish-recipes/asian-salmon-sweet-potato-traybake/",
  "https://www.jamieoliver.com/recipes/fish-recipes/kedgeree/",
  "https://www.jamieoliver.com/recipes/fish-recipes/leek-salmon-parcels/",
  "https://www.jamieoliver.com/recipes/fish-recipes/super-speedy-steamed-salmon/",
  "https://www.jamieoliver.com/recipes/fish/fish-chips-and-mushy-peas/",
  "https://www.jamieoliver.com/recipes/fruit-recipes/classic-apple-crumble/",
  "https://www.jamieoliver.com/recipes/fruit-recipes/mrs-oliver-s-massive-retro-trifle/",
  "https://www.jamieoliver.com/recipes/fruit/frozen-berry-apple-crumble/",
  "https://www.jamieoliver.com/recipes/pasta-recipes/mushroom-carbonara/",
  "https://www.jamieoliver.com/recipes/pasta-recipes/rocket-and-pistachio-pesto-pasta/",
  "https://www.jamieoliver.com/recipes/pasta/spinach-ricotta-cannelloni/",
  "https://www.jamieoliver.com/recipes/rice-recipes/katsu-style-tofu-rice-bowl/",
  "https://www.jamieoliver.com/recipes/soup-recipes/minestrone-soup/",
  "https://www.jamieoliver.com/recipes/vegetable-recipes/mexican-style-roasted-veg-ragu/",
  "https://www.jamieoliver.com/recipes/vegetables-recipes/red-lentil-sweet-potato-coconut-soup/",
  "https://www.jamieoliver.com/recipes/vegetables-recipes/simple-veggie-tofu-stir-fry/",
  "https://www.jamieoliver.com/recipes/vegetables-recipes/sweet-potato-chickpea-amp-spinach-curry/",
  "https://www.jamieoliver.com/recipes/vegetables-recipes/sweet-potato-muffins/",
  "https://www.jamieoliver.com/recipes/vegetables/red-lentil-sweet-potato-coconut-soup/",
  "https://www.jamieoliver.com/recipes/vegetables/veggie-chilli/",
  "https://www.kitchensanctuary.com/pad-thai-recipe/",
  "https://www.loveandlemons.com/french-toast/",
  "https://www.myrecipes.com/recipe/jamaican-jerk-seasoning-blend",
  "https://www.nhs.uk/start4life/weaning/recipes-and-meal-ideas/african-bean-stew/",
  "https://www.nhs.uk/start4life/weaning/recipes-and-meal-ideas/creamy-chicken-and-veg-hotpot/",
  "https://www.nhs.uk/start4life/weaning/recipes-and-meal-ideas/spag-bol/",
  "https://www.ocado.com/webshop/recipe/Peanut-Butter-and-Jam-filled-Scotch-/279315",
  "https://www.ocado.com/webshop/recipe/cauldron-marinated-tofu-udon-noodles/39111",
  "https://www.ohhowcivilized.com/london-fog-drink/",
  "https://www.ohlaliving.com/retro-sprinkle-tray-bake",
  "https://www.oliveandmango.com/bircher-muesli-swiss-oatmeal-overnight-oats/",
  "https://www.olivemagazine.com/recipes/fish-and-seafood/pan-fried-cod-with-giant-beans-and-chard/",
  "https://www.olivemagazine.com/recipes/meat-and-poultry/slow-cooker-sweet-and-sour-chicken/",
  "https://www.olivemagazine.com/recipes/quick-and-easy/jerk-chicken-skewers/",
  "https://www.olivemagazine.com/recipes/quick-and-easy/potato-and-carrot-rosti/",
  "https://www.onceuponachef.com/recipes/pasta-with-sun-dried-tomato-pesto-mozzarella-pearls.html",
  "https://www.onceuponachef.com/recipes/rainbow-sprinkle-funfetti-cake.html",
  "https://www.quorn.co.uk/recipes/quick-and-easy-vegetarian-chilli-con-carne",
  "https://www.quorn.co.uk/recipes/vegetarian-sweet-potato-cottage-pie-recipe",
  "https://www.recipetineats.com/spaghetti-bolognese/#wprm-recipe-container-25094",
  "https://www.riverford.co.uk/recipes/courgette-fritters-with-feta",
  "https://www.savorynothings.com/slow-cooker-irish-beef-stew/",
  "https://www.simplehealthykitchen.com/thai-coconut-soup-with-shrimp-tom-kha-goong/",
  "https://www.spendwithpennies.com/slow-cooker-spaghetti-bolognese/",
  "https://www.tamingtwins.com/slow-cooker-sweet-sour-chicken/",
  "https://www.tasteofhome.com/recipes/baklava-cheesecake/",
  "https://www.tasteofhome.com/recipes/lemon-parsley-baked-cod/",
  "https://www.theenglishkitchen.co/2021/08/mary-berrys-blueberry-muffins.html?m=1",
  "https://www.thespruceeats.com/blue-cheese-sauce-recipe-591620",
  "https://www.thespruceeats.com/vegetarian-bean-and-rice-burrito-recipe-3378550",
  "https://www.waitrose.com/content/waitrose/en/home/recipes/recipe_directory/l/lemon-pistachio-cake.html",
  "https://www.waitrose.com/ecom/recipe/blueberry-buttermilk-pancakes",
  "https://www.wellplated.com/vegan-stuffed-peppers/",
];

const PER_DOMAIN_DELAY_MS = 1200;

interface Success {
  url: string;
  title: string;
  mealType: MealType;
  mealTypeGuessed: boolean;
}
interface Failure {
  url: string;
  reason: string;
}

function domainOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const SUMMARY_PATH = path.join(import.meta.dirname, ".data", "recipeImport-summary.json");

async function writeSummary(succeeded: Success[], failed: Failure[], total: number): Promise<void> {
  await fs.writeFile(SUMMARY_PATH, JSON.stringify({ total, succeeded, failed, updatedAt: new Date().toISOString() }, null, 2), "utf8");
}

async function main() {
  const envSource = loadEnv("development", process.cwd(), "");
  const notionEnv = loadNotionEnv(envSource);
  const llmEnv = loadLlmEnv(envSource);
  if (!notionEnv.token) throw new Error("NOTION_TOKEN is missing from .env");
  if (!notionEnv.recipesDbId) throw new Error("NOTION_RECIPES_DB_ID is missing from .env");
  if (!llmEnv.anthropicApiKey && !llmEnv.openaiApiKey) throw new Error("Neither ANTHROPIC_API_KEY nor OPENAI_API_KEY is set");

  const notion = createNotionClient(notionEnv.token);
  const repo = new NotionRepo(notion, notionEnv);

  const succeeded: Success[] = [];
  const failed: Failure[] = [];
  const lastRequestAtByDomain = new Map<string, number>();

  console.log(`Importing ${URLS.length} recipe URLs...\n`);

  for (let i = 0; i < URLS.length; i++) {
    const url = URLS[i];
    const domain = domainOf(url);
    const lastAt = lastRequestAtByDomain.get(domain) ?? 0;
    const wait = Math.max(0, lastAt + PER_DOMAIN_DELAY_MS - Date.now());
    if (wait > 0) await sleep(wait);
    lastRequestAtByDomain.set(domain, Date.now());

    process.stdout.write(`[${i + 1}/${URLS.length}] ${url} ... `);

    try {
      const result = await extractRecipeFromUrl(envSource, llmEnv, url);
      if (!result.ok) {
        console.log(`SKIP (${result.reason})`);
        failed.push({ url, reason: result.reason });
        await writeSummary(succeeded, failed, URLS.length);
        continue;
      }

      const mealTypeGuessed = result.data.mealType === null;
      const mealType: MealType = result.data.mealType ?? "Dinner";
      await repo.createRecipe(result.data.title, mealType, {
        cuisineType: result.data.cuisineType,
        prepTime: result.data.prepTime,
        cookTime: result.data.cookTime,
        sourceUrl: result.data.sourceUrl,
        ingredients: result.data.ingredients,
        method: result.data.method,
        tags: result.data.tags,
      });
      console.log(`OK — "${result.data.title}" (${mealType}${mealTypeGuessed ? ", defaulted" : ""})`);
      succeeded.push({ url, title: result.data.title, mealType, mealTypeGuessed });
    } catch (error) {
      const reason = error instanceof Error ? error.message : "unexpected error";
      console.log(`SKIP (${reason})`);
      failed.push({ url, reason });
    }

    await writeSummary(succeeded, failed, URLS.length);
  }

  console.log("\n=== Summary ===");
  console.log(`Succeeded: ${succeeded.length}`);
  console.log(`Failed: ${failed.length}`);

  const byMealType = new Map<string, number>();
  for (const s of succeeded) byMealType.set(s.mealType, (byMealType.get(s.mealType) ?? 0) + 1);
  console.log("\nBy Meal Type:");
  for (const [mt, count] of byMealType) console.log(`  ${mt}: ${count}`);

  if (failed.length > 0) {
    console.log("\nFailed URLs:");
    for (const f of failed) console.log(`  - ${f.url} (${f.reason})`);
  }

  console.log(`\nFull summary written to ${SUMMARY_PATH}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
