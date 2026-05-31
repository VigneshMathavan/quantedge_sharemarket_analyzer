// server/path-forecaster/random-forest.js — Pure-JS Random Forest classifier.
//
// Why we built this:
//   The logistic regression model hit its ceiling at AUC ≈ 0.51 because
//   our features have non-linear interactions ("high RSI AND ema slope
//   positive AND atr expanding" is bullish, but no single linear term
//   captures it). Tree ensembles handle these interactions natively.
//
// Architecture:
//   • Random Forest: bag of N independent decision trees
//   • Each tree trained on a bootstrap sample (sampling with replacement)
//   • At each split, only sqrt(num_features) randomly-chosen features
//     are considered → de-correlates trees and reduces overfitting
//   • Final prediction = mean of tree outputs (probability for classification,
//     value for regression)
//
// Pure JS so it can be loaded into the live backend with zero new
// dependencies. Training on ~130k × 10 features takes ~10 seconds.

// ---------- Tree building ----------

function bestSplit(samples, featureIdxs, labelKey) {
    // Best gain by Gini (classification) or MSE reduction (regression).
    // labelKey is a function (sample) → numeric target.
    const N = samples.length;
    if (N < 4) return null;

    const totalLabels = samples.map(labelKey);
    const totalSum = totalLabels.reduce((s, v) => s + v, 0);
    const totalMean = totalSum / N;
    const totalVar = totalLabels.reduce((s, v) => s + (v - totalMean) ** 2, 0);

    let bestGain = 0;
    let bestFeat = null, bestThresh = null;

    for (const fi of featureIdxs) {
        // Sort by feature value
        const sorted = [...samples].sort((a, b) => a.f[fi] - b.f[fi]);
        const labels = sorted.map(labelKey);

        // Try splits at every 1/20th of the sample → fast approximation
        const step = Math.max(1, Math.floor(N / 20));
        let leftSum = 0;
        let leftN = 0;
        for (let i = 1; i < N; i++) {
            leftSum += labels[i - 1];
            leftN = i;
            if (i % step !== 0 || sorted[i].f[fi] === sorted[i - 1].f[fi]) continue;

            const rightSum = totalSum - leftSum;
            const rightN = N - leftN;
            if (leftN < 4 || rightN < 4) continue;

            const leftMean = leftSum / leftN;
            const rightMean = rightSum / rightN;

            // Variance reduction
            let leftVar = 0, rightVar = 0;
            for (let k = 0; k < leftN; k++) leftVar += (labels[k] - leftMean) ** 2;
            for (let k = leftN; k < N; k++) rightVar += (labels[k] - rightMean) ** 2;

            const gain = totalVar - (leftVar + rightVar);
            if (gain > bestGain) {
                bestGain = gain;
                bestFeat = fi;
                bestThresh = (sorted[i - 1].f[fi] + sorted[i].f[fi]) / 2;
            }
        }
    }
    if (bestFeat === null) return null;
    return { feat: bestFeat, thresh: bestThresh, gain: bestGain };
}

function buildTree(samples, labelKey, depth, maxDepth, minSamples, mtry, featureCount) {
    if (samples.length < minSamples || depth >= maxDepth) {
        const mean = samples.reduce((s, x) => s + labelKey(x), 0) / samples.length;
        return { leaf: true, value: mean };
    }
    // Random subset of features for this split
    const featureIdxs = [];
    const all = Array.from({ length: featureCount }, (_, i) => i);
    while (featureIdxs.length < mtry && all.length) {
        const idx = Math.floor(Math.random() * all.length);
        featureIdxs.push(all.splice(idx, 1)[0]);
    }
    const split = bestSplit(samples, featureIdxs, labelKey);
    if (!split) {
        const mean = samples.reduce((s, x) => s + labelKey(x), 0) / samples.length;
        return { leaf: true, value: mean };
    }
    const left = samples.filter(s => s.f[split.feat] <= split.thresh);
    const right = samples.filter(s => s.f[split.feat] > split.thresh);
    if (left.length === 0 || right.length === 0) {
        const mean = samples.reduce((s, x) => s + labelKey(x), 0) / samples.length;
        return { leaf: true, value: mean };
    }
    return {
        leaf: false,
        feat: split.feat,
        thresh: split.thresh,
        left:  buildTree(left,  labelKey, depth + 1, maxDepth, minSamples, mtry, featureCount),
        right: buildTree(right, labelKey, depth + 1, maxDepth, minSamples, mtry, featureCount)
    };
}

function predictTree(tree, features) {
    while (!tree.leaf) {
        tree = (features[tree.feat] <= tree.thresh) ? tree.left : tree.right;
    }
    return tree.value;
}

// ---------- Random Forest ----------

export function trainRandomForest(samples, {
    labelKey, featureCount,
    nTrees = 50,
    maxDepth = 6,
    minSamples = 20,
    mtry = null,
    bootstrapFrac = 0.8
} = {}) {
    if (!mtry) mtry = Math.max(2, Math.floor(Math.sqrt(featureCount)));
    const N = samples.length;
    const targetN = Math.floor(N * bootstrapFrac);
    const trees = [];

    for (let t = 0; t < nTrees; t++) {
        const bag = [];
        for (let i = 0; i < targetN; i++) {
            bag.push(samples[Math.floor(Math.random() * N)]);
        }
        const tree = buildTree(bag, labelKey, 0, maxDepth, minSamples, mtry, featureCount);
        trees.push(tree);
        if ((t + 1) % 10 === 0) process.stdout.write(`    tree ${t+1}/${nTrees}\r`);
    }
    return { trees, featureCount, mtry, maxDepth, nTrees };
}

export function predictForest(forest, features) {
    let sum = 0;
    for (const tree of forest.trees) sum += predictTree(tree, features);
    return sum / forest.trees.length;
}

// AUC computation (probability that random positive scores above random negative)
export function aucForest(samples, forest, isPosFn) {
    const featArr = samples.map(s => s.f);
    const scores = featArr.map(f => predictForest(forest, f));
    const ranked = samples
        .map((s, i) => ({ p: scores[i], y: isPosFn(s) ? 1 : 0 }))
        .sort((a, b) => a.p - b.p);
    let nPos = 0, nNeg = 0, rankSum = 0;
    ranked.forEach((r, i) => {
        if (r.y === 1) { nPos++; rankSum += (i + 1); }
        else nNeg++;
    });
    if (nPos === 0 || nNeg === 0) return 0.5;
    return (rankSum - nPos * (nPos + 1) / 2) / (nPos * nNeg);
}
