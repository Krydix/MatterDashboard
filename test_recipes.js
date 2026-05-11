const { importTrmnlRecipe } = require('./dist/main/trmnl-import.js');
const { resolveKioskTargetUrl } = require('./dist/main/dashboard-runtime.js');

async function testRecipes() {
  const urls = [
    'https://trmnl.com/recipes/296696',
    'https://trmnl.com/recipes/298373',
    'https://trmnl.com/recipes/297288',
    'https://trmnl.com/recipes/296218',
    'https://trmnl.com/recipes/293405'
  ];

  const failures = new Set();
  const successfulSummaries = [];

  for (const url of urls) {
    try {
      const recipe = await importTrmnlRecipe(url);
      const summary = {
        url: url,
        name: recipe.name,
        pollingEnabled: !!(recipe.trmnl && recipe.trmnl.polling && recipe.trmnl.polling.enabled),
        exchangesCount: recipe.exchanges ? recipe.exchanges.length : 0
      };

      try {
        const target = { name: recipe.name, provider: 'trmnl', recipe: recipe };
        const outputUrl = await resolveKioskTargetUrl(target);
        console.log('--- Success ---');
        console.log('Worked URL:', summary.url);
        console.log('Recipe Name:', summary.name);
        console.log('Polling Enabled:', summary.pollingEnabled);
        console.log('Exchanges Count:', summary.exchangesCount);
        console.log('Output URL:', outputUrl);
        return;
      } catch (urlErr) {
        failures.add(urlErr.message);
      }
    } catch (importErr) {
      failures.add(importErr.message);
    }
  }

  console.log('--- Failures ---');
  console.log('All recipes failed. Distinct causes:');
  failures.forEach(f => console.log('-', f));
  process.exit(1);
}

testRecipes().catch(err => {
  console.error('Script Error:', err);
  process.exit(1);
});
