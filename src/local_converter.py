import gmsh
import trimesh
import sys
import os
import math
import numpy as np

def stl_to_step(input_path, output_path):
    """Converts STL to STEP using Gmsh with multi-tier mesh-to-CAD recovery."""
    try:
        # 1. Process mesh with trimesh
        print(f"INFO: Loading mesh: {input_path}")
        mesh = trimesh.load(input_path)
        if isinstance(mesh, trimesh.Scene):
            mesh = mesh.dump(concatenate=True)
            
        initial_faces = len(mesh.faces)
        print(f"INFO: Initial face count: {initial_faces}")
        print(f"INFO: Is watertight: {mesh.is_watertight}")
        
        def repair_mesh(m):
            print(f"DEBUG: Repairing mesh ({len(m.faces)} faces)...")
            try:
                components = m.split(only_watertight=False)
                if len(components) > 1:
                    print(f"DEBUG: Found {len(components)} components, keeping largest.")
                    m = max(components, key=lambda c: len(c.faces))
            except Exception as e:
                print(f"DEBUG: Split failed: {e}")
                
            m.remove_infinite_values()
            m.remove_unreferenced_vertices()
            m.merge_vertices()
            m.fill_holes()
            m.fix_normals()
            m.process(validate=True)
            print(f"DEBUG: Repair done. Watertight: {m.is_watertight}")
            return m

        def save_temp(m, suffix):
            path = input_path + suffix
            m.export(path)
            return path

        gmsh.initialize()
        gmsh.option.setNumber("General.Terminal", 1)
        gmsh.option.setNumber("General.Verbosity", 4)
        
        def print_counts(label):
            counts = [len(gmsh.model.getEntities(t)) for t in [0, 1, 2, 3]]
            print(f"DEBUG: {label} - Nodes: {counts[0]}, Curves: {counts[1]}, Surfaces: {counts[2]}, Volumes: {counts[3]}")
            return counts[2] > 0

        # --- TIER 1: Parametric ---
        try:
            print("INFO: Tier 1: Parametric reconstruction (Original or 50k faces)...")
            t1_mesh = mesh.copy()
            if initial_faces > 50000:
                print("INFO: Decimating for Tier 1 (target 50k)...")
                res = t1_mesh.simplify_quadric_decimation(face_count=50000)
                if res is not None: t1_mesh = res[0] if isinstance(res, tuple) else res
            
            t1_mesh = repair_mesh(t1_mesh)
            t1_stl = save_temp(t1_mesh, ".t1.stl")
            gmsh.open(t1_stl)
            gmsh.model.mesh.classifySurfaces(45 * math.pi / 180., True, True, math.pi)
            gmsh.model.mesh.createGeometry()
            gmsh.model.geo.synchronize()
            if print_counts("Tier 1 Post-Recon") and gmsh.write(output_path):
                print(f"SUCCESS: STEP (Tier 1) saved to {output_path}")
                return
        except Exception as e:
            print(f"WARNING: Tier 1 failed: {str(e)}")

        # --- TIER 2: Discrete Topology ---
        try:
            print("INFO: Tier 2: Discrete topology construction (20k faces)...")
            gmsh.clear()
            t2_mesh = repair_mesh(mesh.copy())
            if len(t2_mesh.faces) > 20000:
                res = t2_mesh.simplify_quadric_decimation(face_count=20000)
                if res is not None: t2_mesh = res[0] if isinstance(res, tuple) else res
            t2_mesh = repair_mesh(t2_mesh)
            t2_stl = save_temp(t2_mesh, ".t2.stl")
            gmsh.open(t2_stl)
            gmsh.model.mesh.createTopology()
            gmsh.model.mesh.createGeometry()
            gmsh.model.geo.synchronize()
            if print_counts("Tier 2 Post-Discrete") and gmsh.write(output_path):
                print(f"SUCCESS: STEP (Tier 2) saved to {output_path}")
                return
        except Exception as e:
            print(f"WARNING: Tier 2 failed: {str(e)}")

        # --- TIER 3: Discrete Topology (Fast) ---
        try:
            print("INFO: Tier 3: Fast discrete topology (No connectivity check)...")
            gmsh.clear()
            t3_mesh = mesh.copy()
            target = 5000 if len(t3_mesh.faces) > 5000 else len(t3_mesh.faces)
            res = t3_mesh.simplify_quadric_decimation(face_count=target)
            if res is not None: t3_mesh = res[0] if isinstance(res, tuple) else res
            t3_mesh = repair_mesh(t3_mesh)
            t3_stl = save_temp(t3_mesh, ".t3.stl")
            gmsh.open(t3_stl)
            gmsh.model.mesh.createTopology(False)
            gmsh.model.mesh.createGeometry()
            gmsh.model.geo.synchronize()
            if print_counts("Tier 3 Post-Fast") and gmsh.write(output_path):
                print(f"SUCCESS: STEP (Tier 3) saved to {output_path}")
                return
        except Exception as e:
            print(f"WARNING: Tier 3 failed: {str(e)}")

        # (Tier 4 skipped due to stability issues with voxelization)

        # --- TIER 5: OCP B-Rep (Ultimate Fallback) ---
        try:
            print("INFO: Tier 5: Direct OCP B-Rep reconstruction (Most robust)...")
            from OCP.StlAPI import StlAPI_Reader
            from OCP.TopoDS import TopoDS_Shape
            import cadquery as cq

            reader = StlAPI_Reader()
            shape = TopoDS_Shape()
            if not reader.Read(shape, input_path):
                 raise Exception("StlAPI_Reader failed to read STL")
            
            # Wrap in CadQuery for export
            from cadquery import exporters
            obj = cq.Workplane("XY").newObject([shape])
            exporters.export(obj, output_path, exporters.ExportTypes.STEP)
            print(f"SUCCESS: STEP (Tier 5) saved to {output_path}")
            return
        except Exception as e:
            print(f"WARNING: Tier 5 failed: {str(e)}")

        # --- FINAL FALLBACK: Raw Gmsh ---
        try:
            print("INFO: Final attempt: Raw Gmsh STEP export...")
            gmsh.clear()
            gmsh.merge(input_path)
            gmsh.write(output_path)
            print(f"SUCCESS: STEP (final) saved to {output_path}")
            return
        except Exception as e:
            print(f"WARNING: Final fallback failed: {str(e)}")

    except Exception as e:
        print(f"FATAL: STEP conversion failed: {str(e)}")
        sys.exit(1)
    finally:
        if gmsh.isInitialized(): gmsh.finalize()
        for f in [".t1.stl", ".t2.stl", ".t3.stl", ".t4.stl"]:
            p = input_path + f
            if os.path.exists(p): os.remove(p)

def stl_to_3mf(input_path, output_path):
    """Converts STL to 3MF using Trimesh."""
    try:
        mesh = trimesh.load(input_path)
        if isinstance(mesh, trimesh.Scene):
            mesh = mesh.dump(concatenate=True)
        mesh.export(output_path, file_type='3mf')
        print(f"SUCCESS: 3MF saved to {output_path}")
    except Exception as e:
        print(f"ERROR: 3MF conversion failed: {str(e)}")
        sys.exit(1)

if __name__ == "__main__":
    if len(sys.argv) < 4:
        print("Usage: python local_converter.py <format> <input_stl> <output_file>")
        sys.exit(1)
    
    fmt = sys.argv[1].lower()
    inp = os.path.abspath(sys.argv[2])
    out = os.path.abspath(sys.argv[3])
    
    if fmt == "step":
        stl_to_step(inp, out)
    elif fmt == "3mf":
        stl_to_3mf(inp, out)
    else:
        print(f"ERROR: Unsupported format {fmt}")
        sys.exit(1)
