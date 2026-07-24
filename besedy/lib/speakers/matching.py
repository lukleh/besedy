"""Speaker matching using hierarchical clustering.

This module provides functions for finding speaker clusters across
multiple audio files using cosine distance and hierarchical clustering.
"""

from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path
from typing import Any

import numpy as np
from scipy.cluster.hierarchy import fcluster, linkage
from scipy.spatial.distance import cdist, squareform

# Type aliases
SpeakerId = tuple[str, str]  # (audio_file_identifier, speaker_label)
EmbeddingMap = dict[SpeakerId, np.ndarray]


def find_speaker_matches(
    embeddings: EmbeddingMap,
    cluster_distance: float = 0.35,
    output_file: Path | None = None,
) -> tuple[Any, list[SpeakerId]] | None:
    """Find clusters of speakers across files using hierarchical clustering.

    Uses average-linkage hierarchical clustering on cosine distances to group
    speakers from different files that likely represent the same person.

    Algorithm:
    1. Compute pairwise cosine distances between all speaker embeddings
    2. Apply average-linkage hierarchical clustering
    3. Cut dendrogram at cluster_distance threshold
    4. Separate multi-file clusters (same speaker) from singleton clusters

    Args:
        embeddings: Map of (file_id, speaker) -> embedding vector.
        cluster_distance: Maximum distance for clustering speakers together.
            Lower values are stricter (fewer matches), higher values are more
            permissive. Default 0.35 is a good starting point.
        output_file: Optional JSON file to save results.

    Returns:
        Tuple of (distance_matrix, speaker_ids) if successful, None otherwise.
    """
    if not embeddings:
        print("\nNo embeddings extracted.")
        return None

    speaker_ids = list(embeddings.keys())
    if len(speaker_ids) < 2:
        print("\nNeed at least two speakers across files to perform clustering.")
        print(
            "Add more diarization outputs or lower --min-duration to capture additional speakers."
        )
        return None

    vectors = [embeddings[sid] for sid in speaker_ids]

    # Compute cosine distance matrix
    print("\n" + "=" * 60)
    print("Computing cosine distance matrix...")
    print("=" * 60)
    stacked = np.stack(vectors, axis=0)
    distance_matrix = cdist(stacked, stacked, metric="cosine")

    # Print distance matrix
    print("\nCosine distance matrix:")
    print("(lower values = more similar speakers)")
    print()

    # Header
    header = "     "
    for i, (file_id, speaker) in enumerate(speaker_ids):
        header += f"  [{i}]"
    print(header)

    for i, (file_id1, speaker1) in enumerate(speaker_ids):
        row = f"[{i}] "
        for j, (file_id2, speaker2) in enumerate(speaker_ids):
            distance = distance_matrix[i, j]
            if i == j:
                row += "  --- "
            else:
                row += f" {distance:.3f}"
        print(row)

    # Legend
    print("\nLegend:")
    for i, (file_id, speaker) in enumerate(speaker_ids):
        print(f"  [{i}] {file_id}:speaker_{speaker}")

    # Collect all cross-file pairs with their distances
    print("\n" + "=" * 60)
    print("All cross-file speaker similarities (sorted by similarity)")
    print("=" * 60)

    pairs = []
    for i in range(len(speaker_ids)):
        for j in range(i + 1, len(speaker_ids)):
            file_id1, speaker1 = speaker_ids[i]
            file_id2, speaker2 = speaker_ids[j]

            # Only consider pairs from different files
            if file_id1 == file_id2:
                continue

            distance = distance_matrix[i, j]
            similarity = 1.0 - distance
            pairs.append(
                {
                    "idx1": i,
                    "idx2": j,
                    "file_id1": file_id1,
                    "speaker1": speaker1,
                    "file_id2": file_id2,
                    "speaker2": speaker2,
                    "distance": distance,
                    "similarity": similarity,
                }
            )

    # Sort by similarity (descending)
    pairs.sort(key=lambda x: x["similarity"], reverse=True)

    # Show top matches
    print("\nTop 20 most similar speaker pairs:")
    for i, pair in enumerate(pairs[:20], 1):
        print(
            f"{i:2d}. [{pair['idx1']:2d}]-[{pair['idx2']:2d}] "
            f"{pair['file_id1']}:speaker_{pair['speaker1']} ↔ "
            f"{pair['file_id2']}:speaker_{pair['speaker2']} "
            f"(similarity: {pair['similarity']:.1%}, distance: {pair['distance']:.3f})"
        )

    # Perform hierarchical clustering
    print("\n" + "=" * 60)
    print(f"Clustering speakers (max distance: {cluster_distance})")
    print("=" * 60)

    # Convert distance matrix to condensed form for scipy.
    # Same-file speakers must NEVER be clustered together (by definition they're different
    # people in the same recording). We set their distance to a value that ensures they
    # won't merge under any reasonable threshold.
    distance_matrix_copy = distance_matrix.copy()
    # WHY max(cluster_distance + 1.0, 2.0): Ensures same-file distance exceeds both the
    # user's threshold AND the maximum possible cosine distance (2.0 for opposite vectors).
    # This guarantees same-file speakers are never clustered regardless of threshold.
    ignore_distance = max(cluster_distance + 1.0, 2.0)
    for i in range(len(speaker_ids)):
        for j in range(len(speaker_ids)):
            if i == j:
                continue
            if speaker_ids[i][0] == speaker_ids[j][0]:  # Same file
                distance_matrix_copy[i, j] = ignore_distance

    # Replace diagonal with 0 (self-distance must be 0 for scipy)
    np.fill_diagonal(distance_matrix_copy, 0.0)

    # WHY average linkage: More robust than single-linkage (which chains outliers) or
    # complete-linkage (which over-fragments). Average linkage balances between finding
    # tight clusters and allowing natural variance in speaker embeddings.
    condensed_distances = squareform(distance_matrix_copy)

    linkage_matrix = linkage(condensed_distances, method="average")

    # Cut the dendrogram at the specified distance
    cluster_labels = fcluster(linkage_matrix, t=cluster_distance, criterion="distance")

    # Group speakers by cluster
    clusters = {}
    for idx, cluster_id in enumerate(cluster_labels):
        if cluster_id not in clusters:
            clusters[cluster_id] = []
        clusters[cluster_id].append(idx)

    # Separate multi-file clusters and singleton clusters
    multi_file_clusters = []
    singleton_clusters = []

    for cluster_id, members in clusters.items():
        # Check if cluster has speakers from different files
        files_in_cluster = set(speaker_ids[idx][0] for idx in members)
        if len(files_in_cluster) > 1:
            multi_file_clusters.append((cluster_id, members))
        else:
            singleton_clusters.append((cluster_id, members))

    # Sort clusters by size (descending)
    multi_file_clusters.sort(key=lambda x: len(x[1]), reverse=True)
    singleton_clusters.sort(key=lambda x: len(x[1]), reverse=True)

    print(f"\nFound {len(multi_file_clusters)} cluster(s) with speakers from multiple files")
    print(f"Found {len(singleton_clusters)} singleton cluster(s) (single file only)")
    print()

    cluster_results = []

    # Process multi-file clusters first
    for cluster_num, (cluster_id, members) in enumerate(multi_file_clusters, 1):
        files_in_cluster = set(speaker_ids[idx][0] for idx in members)

        # Calculate cluster statistics
        intra_distances = []
        for i, idx1 in enumerate(members):
            for idx2 in members[i + 1 :]:
                if speaker_ids[idx1][0] != speaker_ids[idx2][0]:  # Different files
                    intra_distances.append(distance_matrix[idx1, idx2])

        max_dist = max(intra_distances) if intra_distances else 0.0
        avg_dist = np.mean(intra_distances) if intra_distances else 0.0
        min_dist = min(intra_distances) if intra_distances else 0.0

        print(
            f"Cluster {cluster_num}: {len(members)} speaker(s) from {len(files_in_cluster)} file(s)"
        )
        print(
            f"  Intra-cluster distance: min={min_dist:.3f}, avg={avg_dist:.3f}, max={max_dist:.3f}"
        )
        print("  Members:")

        for idx in members:
            file_id, speaker = speaker_ids[idx]
            print(f"    [{idx:2d}] {file_id}:speaker_{speaker}")

        cluster_results.append(
            {
                "cluster_id": cluster_num,
                "size": len(members),
                "num_files": len(files_in_cluster),
                "members": [
                    {"index": idx, "file_id": speaker_ids[idx][0], "speaker": speaker_ids[idx][1]}
                    for idx in members
                ],
                "distances": {
                    "min": float(min_dist),
                    "avg": float(avg_dist),
                    "max": float(max_dist),
                },
            }
        )
        print()

    # Process singleton clusters (speakers from single files only)
    starting_cluster_num = len(multi_file_clusters) + 1
    for cluster_num, (cluster_id, members) in enumerate(singleton_clusters, starting_cluster_num):
        files_in_cluster = set(speaker_ids[idx][0] for idx in members)

        print(
            f"Cluster {cluster_num}: {len(members)} speaker(s) from "
            f"{len(files_in_cluster)} file(s) [SINGLETON]"
        )
        print(
            "  Intra-cluster distance: N/A (single-file cluster, cross-file comparison not applicable)"
        )
        print("  Members:")

        for idx in members:
            file_id, speaker = speaker_ids[idx]
            print(f"    [{idx:2d}] {file_id}:speaker_{speaker}")

        cluster_results.append(
            {
                "cluster_id": cluster_num,
                "size": len(members),
                "num_files": len(files_in_cluster),
                "members": [
                    {"index": idx, "file_id": speaker_ids[idx][0], "speaker": speaker_ids[idx][1]}
                    for idx in members
                ],
                "distances": None,  # N/A for single-file clusters
            }
        )
        print()

    if not multi_file_clusters:
        print(f"No cross-file matches found with cluster distance {cluster_distance}")
        print("Try increasing --cluster-distance to find weaker matches")

    # Save to JSON if output file specified
    if output_file:
        result = {
            "metadata": {
                "cluster_distance": cluster_distance,
                "num_files": len(set(file_id for file_id, _ in speaker_ids)),
                "num_speakers": len(speaker_ids),
                "num_clusters": len(multi_file_clusters) + len(singleton_clusters),
                "num_multi_file_clusters": len(multi_file_clusters),
                "num_singleton_clusters": len(singleton_clusters),
                "timestamp": datetime.now().isoformat(),
            },
            "speakers": [
                {
                    "index": i,
                    "file_id": file_id,
                    "speaker": speaker,
                }
                for i, (file_id, speaker) in enumerate(speaker_ids)
            ],
            "distance_matrix": distance_matrix.tolist(),
            "all_pairs": [
                {
                    "file_id_1": pair["file_id1"],
                    "speaker_1": pair["speaker1"],
                    "file_id_2": pair["file_id2"],
                    "speaker_2": pair["speaker2"],
                    "cosine_distance": float(pair["distance"]),
                    "similarity_percent": round(pair["similarity"] * 100, 1),
                }
                for pair in pairs
            ],
            "clusters": cluster_results,
        }

        output_file.parent.mkdir(parents=True, exist_ok=True)
        with output_file.open("w", encoding="utf-8") as f:
            json.dump(result, f, indent=2, ensure_ascii=False)

        print(f"\n{'=' * 60}")
        print(f"Saved results to: {output_file}")
        print(f"{'=' * 60}")

    return distance_matrix, speaker_ids
