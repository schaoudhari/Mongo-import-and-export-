require("dotenv").config();

const fs = require("fs");
const path = require("path");
const { MongoClient, BSON: { EJSON } } = require("mongodb");

function argValue(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

async function main() {
  const target = argValue("--target", "development").toLowerCase();
  const inputArg = argValue("--input", "");
  const drop = process.argv.includes("--drop");

  if (!["production", "development"].includes(target)) {
    throw new Error('Use --target production or --target development.');
  }
  if (!inputArg) {
    throw new Error("Missing --input <export-folder>.");
  }

  const uri = process.env[`MONGODB_${target.toUpperCase()}_URI`];
  const dbName = process.env[`MONGODB_${target.toUpperCase()}_DB`];
  const prefix = process.env.COLLECTION_PREFIX;

  if (!uri || uri.includes("<") || !dbName || !prefix) {
    throw new Error(
      `Check .env: MONGODB_${target.toUpperCase()}_URI, ` +
      `MONGODB_${target.toUpperCase()}_DB, and COLLECTION_PREFIX are required.`
    );
  }

  const inputDir = path.resolve(inputArg);
  if (!fs.existsSync(inputDir) || !fs.statSync(inputDir).isDirectory()) {
    throw new Error(`Input folder not found: ${inputDir}`);
  }

  const manifestPath = path.join(inputDir, "manifest.json");
  if (!fs.existsSync(manifestPath)) {
    throw new Error("manifest.json not found in input folder. Use a folder created by the export script.");
  }

  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (manifest.collectionPrefix !== prefix) {
    throw new Error(
      `Safety check: export prefix "${manifest.collectionPrefix}" does not match current COLLECTION_PREFIX "${prefix}".`
    );
  }

  const entries = manifest.collections || [];
  if (!entries.length) throw new Error("Manifest contains no collections.");

  for (const entry of entries) {
    if (!entry.name.startsWith(prefix)) {
      throw new Error(`Safety check failed: collection "${entry.name}" does not start with "${prefix}".`);
    }
    const filePath = path.join(inputDir, entry.file);
    if (!fs.existsSync(filePath)) throw new Error(`Missing export file: ${entry.file}`);
  }

  console.log(`Target: ${target}/${dbName}`);
  console.log(`Prefix: ${prefix}`);
  console.log(`Collections to import: ${entries.length}`);
  console.log(drop
    ? "WARNING: --drop enabled; matching target collections will be dropped before import."
    : "Import mode: merge/upsert by _id; existing documents with matching _id will be replaced.");

  const client = new MongoClient(uri);
  try {
    await client.connect();
    const db = client.db(dbName);

    for (const entry of entries) {
      const docs = EJSON.parse(fs.readFileSync(path.join(inputDir, entry.file), "utf8"), { relaxed: false });
      const collection = db.collection(entry.name);

      if (drop) {
        await collection.drop().catch(err => {
          if (err.codeName !== "NamespaceNotFound" && err.code !== 26) throw err;
        });
      }

      if (docs.length) {
        const operations = docs.map(doc => ({
          replaceOne: { filter: { _id: doc._id }, replacement: doc, upsert: true }
        }));
        const result = await collection.bulkWrite(operations, { ordered: false });
        console.log(
          `Imported ${entry.name}: ${docs.length} document(s) ` +
          `(upserted ${result.upsertedCount}, modified ${result.modifiedCount})`
        );
      } else {
        console.log(`Imported ${entry.name}: empty collection in export`);
      }
    }

    console.log("\nImport complete.");
  } finally {
    await client.close();
  }
}

main().catch(err => {
  console.error("Import failed:", err.message);
  process.exitCode = 1;
});
