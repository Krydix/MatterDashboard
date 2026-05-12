const { importRecipe, resolveKioskTargetUrl } = require('./dist/main/trmnl-import.js');
const { getKioskTargetFromRecipe } = require('./dist/main/dashboard-runtime.js');

async function runTest() {
  try {
    const url = 'https://trmnl.com/recipes/278680';
    const recipe = await importRecipe(url);
    console.log('Imported recipe name:', recipe.name);
    
    const target = getKioskTargetFromRecipe(recipe);
    console.log('Polling configured:', !!target.pollingInterval);
    
    const outputUrl = resolveKioskTargetUrl(target);
    console.log('Generated output URL:', outputUrl);
  } catch (error) {
    console.error('Smoke test failed:', error.message);
    process.exit(1);
  }
}

runTest();
