# 📘 User Manual: Onshape Model Exporter

Welcome! This tool is designed to help you export many variations of your Onshape models at once, without having to do it manually. This manual is written for everyone, whether you're a designer, engineer, or hobbyist.

---

## 🚀 Getting Started

### 1. Download the Tool

1. Go to the [Releases](https://github.com/CosticaPuntaru/onshape-permutation-config-exporter/releases) page.
2. Download the file that matches your computer:
   * **Windows:** `onshape-exporter-win.zip`
   * **Mac:** `onshape-exporter-mac.zip`
   * **Linux:** `onshape-exporter-linux.tar.gz`
3. Extract (unzip) the file into a folder on your computer.

### 2. Get Your Onshape API Keys

To talk to Onshape, the tool needs a "key" that identifies you.

1. Visit [dev-portal.onshape.com/keys](https://dev-portal.onshape.com/keys) and sign in.
2. Click **Create new API key**.
3. Check all the "Read" permissions (and "Write" if you want the tool to be able to do more later).
4. **Important:** You will see an **Access Key** and a **Secret Key**. Copy these somewhere safe! You'll only see the Secret Key once.

Note: Onshape has a limit of 2500 api calls on free acount, be mindefull of that, 1 export = 1 api call

---

## 🛠️ Using the Tool for the First Time

1. Open the folder where you extracted the tool.
2. Double-click `onshape-exporter.exe` (on Windows) or run `./onshape-exporter` (on Mac/Linux).
3. On the first launch, it will ask for your **Access Key** and **Secret Key**. Paste them in and press Enter.
4. The tool will now save these keys in a hidden file called `.env` in the same folder, so you don't have to enter them again.

---

## 📂 Adding Your First Model

The tool uses an interactive menu. Use your **Up/Down arrow keys** to navigate and **Enter** to select.

1. Select **➕ Add New Model**.
2. **Model Name:** Give it a friendly name (e.g., `Custom-Bracket`). Only use letters, numbers, and dashes.
3. **Onshape URL:** Go to your Onshape Document in your browser, make sure you're on the **Part Studio** tab you want to export, and copy the entire URL from the address bar. Paste it into the tool.
4. **Formats:** Use the Spacebar to select which formats you want (STL, STEP, 3MF, etc.) and press Enter.

---

## ⚙️ Setting Up Variations (Permutations)

This is the most powerful part of the tool. It looks at your Onshape Configuration and lets you pick which combinations you want.

1. From the main menu, select your model name.
2. Select **⚙️ Permutations**.
3. The tool will fetch your Onshape configuration parameters.
4. For each parameter:
   * **List (Enum):** Check the boxes for the values you want.
   * **True/False (Boolean):** Select which states you want.
   * **Numbers:** Type the values you want, separated by commas (e.g., `10mm, 20mm, 30mm`).
5. Once you're done, the tool will show you how many total variations it will create. Confirm to save.

---

## 📐 Preparing your Onshape Model

For the tool to see your variables, you must define them in the **Configurations** panel within Onshape.

1. In your Onshape Document, click the **Configuration Panel** icon on the far right.
2. Click **Configure Part Studio** and add "Configuration parameters".
3. The tool supports these types:
   * **List (Enum):** Perfect for material names or pre-set sizes.
   * **Checkbox (Boolean):** Useful for turning features on/off (e.g., `HasBottom`).
   * **Variable (Quantity):** Best for dimensions (e.g., `Width`, `Height`).

For a detailed guide on how to set these up in Onshape, see the official **[Onshape Configurations Documentation](https://cad.onshape.com/help/Content/configurations.htm)**.

---

## 📦 Running the Export

Select your model and choose **📦 Export**. The tool will:

1. Calculate every combination you defined.
2. Check if you already exported them (it won't re-download files you already have).
3. Start downloading the files into a `dist/` folder inside your tool's directory.

---

## 🖼️ Creating a 3D Preview Grid

Want to see all your variations at a glance?

1. Select your model.
2. Choose **🖼️ Preview**.
3. The tool will open a hidden browser window, render every variation, and save a combined image as `preview.png` in your model's folder.

> **Note:** The first time you do this, it might ask to install "Playwright". Just follow the prompts.

---

## 📁 Where are my files?

Everything is organized in the `dist` folder:

```text
dist/
└── custom-bracket/ (Your model name)
    ├── STL/        (Standard 3D files)
    ├── STEP/       (High-quality CAD files)
    ├── 3MF/        (Optimized printing files)
    └── preview.png (The visual overview)
```

---

## ❓ Troubleshooting

* **"Permission Denied" (Mac/Linux):** You might need to make the file executable. Open your terminal in the folder and type: `chmod +x onshape-exporter`
* **API Key Error:** Double-check that you copied the keys correctly and that they have "Read" permissions.
* **STEP/3MF Files are slow:** By default, the tool uses Onshape's Cloud API to translate these files if you don't have Python installed. If you want "Turbo Mode" (faster local conversion), you can install Python and the required libraries, but it's not required for the tool to work!

---

**Happy Exporting!** 🚀
