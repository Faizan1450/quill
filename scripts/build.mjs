import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

const ROOT_DIR = process.cwd();
const TEMP_BUILD_DIR = path.join(ROOT_DIR, 'dist_temp');
const ZIP_NAME = 'draftly-v1.0.0.zip';
const ZIP_PATH = path.join(ROOT_DIR, ZIP_NAME);

// Step 1: Security Audit
console.log('🔍 Running Security Audit...');
const scanFiles = (dir) => {
  const files = fs.readdirSync(dir);
  for (const file of files) {
    const fullPath = path.join(dir, file);
    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) {
      if (file !== 'node_modules' && file !== 'scratch' && file !== 'scripts' && file !== '.git') {
        scanFiles(fullPath);
      }
    } else if (file.endsWith('.js') || file.endsWith('.json') || file.endsWith('.html') || file.endsWith('.css')) {
      const content = fs.readFileSync(fullPath, 'utf8');
      if (content.includes('AIzaSy') || content.includes('AQ.Ab8')) {
        console.error(`❌ Security Failure: Hardcoded API key found in ${fullPath}!`);
        process.exit(1);
      }
    }
  }
};
scanFiles(path.join(ROOT_DIR, 'src'));
console.log('✅ Security Audit passed (no hardcoded API keys in src/).');

// Step 2: Clean and Recreate temporary build directory
if (fs.existsSync(TEMP_BUILD_DIR)) {
  fs.rmSync(TEMP_BUILD_DIR, { recursive: true, force: true });
}
fs.mkdirSync(TEMP_BUILD_DIR);

// Step 3: Copy required files
console.log('📁 Copying extension files to temp directory...');
fs.copyFileSync(path.join(ROOT_DIR, 'manifest.json'), path.join(TEMP_BUILD_DIR, 'manifest.json'));
fs.cpSync(path.join(ROOT_DIR, 'src'), path.join(TEMP_BUILD_DIR, 'src'), { recursive: true });
fs.cpSync(path.join(ROOT_DIR, 'icons'), path.join(TEMP_BUILD_DIR, 'icons'), { recursive: true });

// Step 4: Zip bundling
console.log('🤐 Creating zip archive...');
if (fs.existsSync(ZIP_PATH)) {
  fs.unlinkSync(ZIP_PATH);
}

try {
  // Use native macOS zip command
  execSync(`zip -r "${ZIP_PATH}" *`, { cwd: TEMP_BUILD_DIR });
  console.log(`✅ Bundle created successfully: ${ZIP_NAME}`);
} catch (err) {
  console.error('❌ Failed to zip files:', err);
  process.exit(1);
} finally {
  // Clean up temp dir
  console.log('🧹 Cleaning up temporary directory...');
  fs.rmSync(TEMP_BUILD_DIR, { recursive: true, force: true });
}

console.log('🎉 Release preparation completed successfully!');
