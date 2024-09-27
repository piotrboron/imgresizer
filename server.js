const express = require("express");
const multer = require("multer");
const sharp = require("sharp");
const path = require("path");
const fs = require("fs");
const rateLimit = require("express-rate-limit");
const axios = require("axios");
const archiver = require("archiver");

const app = express();
const port = 3000;

// variables
var totalSaved = 0;

//this is a fake api key
//real one should be in .env
const masterKey = "42743428-ce90-4941-9ddb-784e2aed091f";

// Middleware to check for valid API key
function requireApiKey(req, res, next) {
  const apiKey = req.get("apiKey");
  if (!apiKey || apiKey !== masterKey) {
    return res.status(401).json({ error: "Invalid API key" });
  }
  next();
}

//rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  limit: 100, // Limit each IP to 100 requests per `window` (here, per 15 minutes).
  standardHeaders: "draft-7", // draft-6: `RateLimit-*` headers; draft-7: combined `RateLimit` header
  legacyHeaders: false, // Disable the `X-RateLimit-*` headers.
  // store: ... , // Redis, Memcached, etc. See below.
});
app.use(limiter);

// multer, multiple files
const upload = multer({
  dest: "uploads/",
  limits: { fileSize: 30 * 1024 * 1024 }, // 30MB limit per file
});

// static files
app.use(express.static("public"));
app.use(express.urlencoded({ extended: true }));

// ensure necessary directories exists
if (!fs.existsSync("uploads")) {
  fs.mkdirSync("uploads");
}

if (!fs.existsSync("public/processed")) {
  fs.mkdirSync("public/processed");
}

// APP GET ROUTES

app.post(
  "/upload-multiple",
  limiter,
  upload.array("images", 30),
  async (req, res) => {
    //simple logs
    console.log("--------------------------------");
    console.log("New multiple file upload request from IP: " + req.ip);
    console.log("Requests remaining: " + req.rateLimit.remaining);
    //if no file , err
    if (!req.files || req.files.length === 0) {
      return res.status(400).send("No files uploaded.");
    }

    const format = req.body.format || "webp"; // Default format
    const width = req.body.width ? parseInt(req.body.width) : null;
    const height = req.body.height ? parseInt(req.body.height) : null;

    if (
      (width && (isNaN(width) || width <= 0 || width > 5000)) ||
      (height && (isNaN(height) || height <= 0 || height > 5000))
    ) {
      return res
        .status(400)
        .send(
          "Width and height must be positive integers not exceeding 5000 pixels."
        );
    }

    const supportedFormats = ["jpeg", "png", "webp", "avif", "jpg"];
    if (!supportedFormats.includes(format.toLowerCase())) {
      return res
        .status(400)
        .send(`Supported formats are: ${supportedFormats.join(", ")}`);
    }

    const zipFilename = `processed_images_${crypto.randomUUID()}.zip`;
    const zipPath = path.join(__dirname, "public", "processed", zipFilename);
    const output = fs.createWriteStream(zipPath);
    const archive = archiver("zip", { zlib: { level: 9 } });

    output.on("close", function () {
      console.log(archive.pointer() + " total bytes");
      console.log(
        "Archiver has been finalized and the output file descriptor has closed."
      );

      res.download(zipPath, zipFilename, (err) => {
        if (err) {
          console.error("Error downloading zip file:", err);
          res.status(500).send("Error downloading zip file");
        }
        // cleaning: delete the zip file and processed images
        fs.unlinkSync(zipPath);
        req.files.forEach((file) => fs.unlinkSync(file.path));
      });
    });

    archive.on("error", function (err) {
      throw err;
    });

    archive.pipe(output);

    try {
      for (const file of req.files) {
        const inputPath = file.path;
        const processedBuffer = await sharp(inputPath)
          .resize({ width, height })
          .toFormat(format)
          .toBuffer();

        archive.append(processedBuffer, {
          name: `processed_${path.basename(
            file.originalname,
            path.extname(file.originalname)
          )}.${format}`,
        });

        // log file sizes and update total saved
        const originalSize = fs.statSync(inputPath).size;
        const processedSize = processedBuffer.length;
        console.log(
          `File ${file.originalname}: Original size: ${
            originalSize / 1024
          } KB, Processed size: ${processedSize / 1024} KB`
        );
        addToTotalSaved(originalSize - processedSize);
      }

      archive.finalize();
    } catch (error) {
      console.error("Error processing images:", error);
      res.status(500).send("Error processing images");
    }
  }
);

app.get("/createuser", (req, res) => {
  var newuserkey = crypto.randomUUID();
  res.send(newuserkey);
  //WORK IN PROGRESS
});

app.get("/api/optimizer", requireApiKey, async (req, res) => {
  // request log
  console.log("--------------------------------");
  console.log("New API request from IP: " + req.ip);
  console.log("Requests remaining: " + req.rateLimit.remaining);
  console.log("--------------------------------");
  // query body
  const { imgurl, width, height, format } = req.query;
  // validate width and height
  const parsedWidth = parseInt(width);
  const parsedHeight = parseInt(height);
  if (
    isNaN(parsedWidth) ||
    isNaN(parsedHeight) ||
    parsedWidth <= 0 ||
    parsedHeight <= 0 ||
    parsedWidth > 5000 ||
    parsedHeight > 5000
  ) {
    return res.status(400).json({
      error: "Invalid dimensions",
      message: "Width and height must be positive integers not exceeding 5000.",
    });
  }

  // Validate format
  const supportedFormats = ["jpeg", "png", "webp", "avif"];
  if (!supportedFormats.includes(format.toLowerCase())) {
    return res.status(400).json({
      error: "Unsupported format",
      message: `Supported formats are: ${supportedFormats.join(", ")}`,
    });
  }
  // check if empty query
  if (!imgurl || !width || !height || !format) {
    return res
      .status(400)
      .send("Image URL, width, height, and format are required.");
  }

  // main thing
  try {
    const response = await axios({
      url: imgurl,
      responseType: "arraybuffer",
    });

    const processedBuffer = await sharp(response.data)
      .resize({ width: parseInt(width), height: parseInt(height) })
      .toFormat(format)
      .toBuffer();

    res.type(`image/${format}`);
    res.send(processedBuffer);
  } catch (error) {
    console.error("Error processing image:", error);
    res.status(500).send("Error processing image");
  }
});

app.post("/upload", limiter, upload.single("image"), async (req, res) => {
  //log user ip
  console.log("--------------------------------");
  console.log("New form request from IP: " + req.ip);

  //log ratelimit
  console.log("Requests remaining: " + req.rateLimit.remaining);

  // check if file is uploaded
  if (!req.file) {
    return res.status(400).send("No file uploaded.");
  }

  const format = req.body.format ? req.body.format : metadata.format;
  const inputPath = req.file.path;
  const outputFilename = `processed_${Date.now()}.${format}`;
  console.log(outputFilename);
  const outputPath = path.join(
    __dirname,
    "public",
    "processed",
    outputFilename
  );

  try {
    //added
    const metadata = await sharp(inputPath).metadata();
    const width = req.body.width ? parseInt(req.body.width) : metadata.width;
    const height = req.body.height
      ? parseInt(req.body.height)
      : metadata.height;
    //added2
    if (width > 5000 || height > 5000) {
      return res
        .status(400)
        .send("Width or height cannot be higher than 5000 pixels!");
    }
    //main
    await sharp(inputPath)
      .resize({
        width: parseInt(width),
        height: parseInt(height),
      })
      .toFormat(format)
      .toFile(outputPath);

    // filesize log
    const originalSize = fs.statSync(inputPath).size;
    const processedSize = fs.statSync(outputPath).size;
    console.log("file size before conversion: " + originalSize / 1024 + " kb");
    console.log("file size after conversion: " + processedSize / 1024 + " kb");
    addToTotalSaved(originalSize - processedSize);
    //txt log
    fs.appendFile(
      "message.txt",
      "User with IP " +
        res.ip +
        " has uploaded a file with filename " +
        outputFilename +
        "\n",
      function (err) {
        if (err) throw err;
        console.log("Saved!");
      }
    );

    // clean the original uploaded file
    fs.unlinkSync(inputPath);

    // res.download to send the file to user
    res.download(outputPath, outputFilename, (err) => {
      if (err) {
        console.error("Error downloading file:", err);
        res.status(500).send("Error downloading file");
      }
      // Delete the processed file after sending
      fs.unlinkSync(outputPath);
    });
  } catch (error) {
    console.error("Error processing image:", error);
    res.status(500).send("Error processing image");
  }
});

async function addToTotalSaved(saved) {
  if (saved > 0) {
    totalSaved = totalSaved + saved;
    console.log(totalSaved / 1024 + " KB saved ever launch");
  }
}

app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
  console.log(`http://localhost:${port}`);
});
