export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  graphql_public: {
    Tables: {
      [_ in never]: never
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      graphql: {
        Args: {
          extensions?: Json
          operationName?: string
          query?: string
          variables?: Json
        }
        Returns: Json
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  public: {
    Tables: {
      absence_decisions: {
        Row: {
          absence_record_id: string
          corrected_absence_type_id: string | null
          created_at: string
          decided_at: string
          decided_by: string
          decision_status: string
          id: string
          is_current: boolean
          reason: string | null
        }
        Insert: {
          absence_record_id: string
          corrected_absence_type_id?: string | null
          created_at?: string
          decided_at?: string
          decided_by: string
          decision_status: string
          id?: string
          is_current?: boolean
          reason?: string | null
        }
        Update: {
          absence_record_id?: string
          corrected_absence_type_id?: string | null
          created_at?: string
          decided_at?: string
          decided_by?: string
          decision_status?: string
          id?: string
          is_current?: boolean
          reason?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "absence_decisions_absence_record_id_fkey"
            columns: ["absence_record_id"]
            isOneToOne: false
            referencedRelation: "absence_records"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "absence_decisions_corrected_absence_type_id_fkey"
            columns: ["corrected_absence_type_id"]
            isOneToOne: false
            referencedRelation: "absence_types"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "absence_decisions_decided_by_fkey"
            columns: ["decided_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      absence_records: {
        Row: {
          absence_type_id: string
          created_at: string
          employee_id: string
          end_date: string
          external_id: string | null
          id: string
          is_current: boolean
          source: string
          source_hash: string
          source_updated_at: string | null
          source_version: number
          start_date: string
          sync_run_id: string | null
          synced_at: string
        }
        Insert: {
          absence_type_id: string
          created_at?: string
          employee_id: string
          end_date: string
          external_id?: string | null
          id?: string
          is_current?: boolean
          source?: string
          source_hash: string
          source_updated_at?: string | null
          source_version?: number
          start_date: string
          sync_run_id?: string | null
          synced_at?: string
        }
        Update: {
          absence_type_id?: string
          created_at?: string
          employee_id?: string
          end_date?: string
          external_id?: string | null
          id?: string
          is_current?: boolean
          source?: string
          source_hash?: string
          source_updated_at?: string | null
          source_version?: number
          start_date?: string
          sync_run_id?: string | null
          synced_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "absence_records_absence_type_id_fkey"
            columns: ["absence_type_id"]
            isOneToOne: false
            referencedRelation: "absence_types"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "absence_records_employee_id_fkey"
            columns: ["employee_id"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "absence_records_sync_run_id_fkey"
            columns: ["sync_run_id"]
            isOneToOne: false
            referencedRelation: "sync_runs"
            referencedColumns: ["id"]
          },
        ]
      }
      absence_types: {
        Row: {
          active: boolean
          code: string
          created_at: string
          id: string
          name: string
        }
        Insert: {
          active?: boolean
          code: string
          created_at?: string
          id?: string
          name: string
        }
        Update: {
          active?: boolean
          code?: string
          created_at?: string
          id?: string
          name?: string
        }
        Relationships: []
      }
      attendance_records: {
        Row: {
          actual_clock_in: string | null
          actual_clock_out: string | null
          created_at: string
          employee_id: string
          external_id: string | null
          id: string
          is_current: boolean
          source: string
          source_hash: string
          source_updated_at: string | null
          source_version: number
          sync_run_id: string | null
          synced_at: string
          work_date: string
        }
        Insert: {
          actual_clock_in?: string | null
          actual_clock_out?: string | null
          created_at?: string
          employee_id: string
          external_id?: string | null
          id?: string
          is_current?: boolean
          source?: string
          source_hash: string
          source_updated_at?: string | null
          source_version?: number
          sync_run_id?: string | null
          synced_at?: string
          work_date: string
        }
        Update: {
          actual_clock_in?: string | null
          actual_clock_out?: string | null
          created_at?: string
          employee_id?: string
          external_id?: string | null
          id?: string
          is_current?: boolean
          source?: string
          source_hash?: string
          source_updated_at?: string | null
          source_version?: number
          sync_run_id?: string | null
          synced_at?: string
          work_date?: string
        }
        Relationships: [
          {
            foreignKeyName: "attendance_records_employee_id_fkey"
            columns: ["employee_id"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "attendance_records_sync_run_id_fkey"
            columns: ["sync_run_id"]
            isOneToOne: false
            referencedRelation: "sync_runs"
            referencedColumns: ["id"]
          },
        ]
      }
      audit_log: {
        Row: {
          action: string
          actor_id: string | null
          entity_id: string
          entity_type: string
          id: string
          metadata: Json | null
          occurred_at: string
        }
        Insert: {
          action: string
          actor_id?: string | null
          entity_id: string
          entity_type: string
          id?: string
          metadata?: Json | null
          occurred_at?: string
        }
        Update: {
          action?: string
          actor_id?: string | null
          entity_id?: string
          entity_type?: string
          id?: string
          metadata?: Json | null
          occurred_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "audit_log_actor_id_fkey"
            columns: ["actor_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      daily_reviews: {
        Row: {
          created_at: string
          employee_id: string
          id: string
          status: Database["public"]["Enums"]["daily_review_status"]
          updated_at: string
          weekly_review_id: string | null
          work_date: string
        }
        Insert: {
          created_at?: string
          employee_id: string
          id?: string
          status?: Database["public"]["Enums"]["daily_review_status"]
          updated_at?: string
          weekly_review_id?: string | null
          work_date: string
        }
        Update: {
          created_at?: string
          employee_id?: string
          id?: string
          status?: Database["public"]["Enums"]["daily_review_status"]
          updated_at?: string
          weekly_review_id?: string | null
          work_date?: string
        }
        Relationships: [
          {
            foreignKeyName: "daily_reviews_employee_id_fkey"
            columns: ["employee_id"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "daily_reviews_weekly_review_id_fkey"
            columns: ["weekly_review_id"]
            isOneToOne: false
            referencedRelation: "weekly_reviews"
            referencedColumns: ["id"]
          },
        ]
      }
      employee_groups: {
        Row: {
          active: boolean
          code: string
          created_at: string
          id: string
          name: string
        }
        Insert: {
          active?: boolean
          code: string
          created_at?: string
          id?: string
          name: string
        }
        Update: {
          active?: boolean
          code?: string
          created_at?: string
          id?: string
          name?: string
        }
        Relationships: []
      }
      employees: {
        Row: {
          active: boolean
          created_at: string
          display_name: string
          employee_group_id: string | null
          external_workera_id: string
          first_name: string
          id: string
          last_name: string
          rut: string | null
          updated_at: string
        }
        Insert: {
          active?: boolean
          created_at?: string
          display_name: string
          employee_group_id?: string | null
          external_workera_id: string
          first_name: string
          id?: string
          last_name: string
          rut?: string | null
          updated_at?: string
        }
        Update: {
          active?: boolean
          created_at?: string
          display_name?: string
          employee_group_id?: string | null
          external_workera_id?: string
          first_name?: string
          id?: string
          last_name?: string
          rut?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "employees_employee_group_id_fkey"
            columns: ["employee_group_id"]
            isOneToOne: false
            referencedRelation: "employee_groups"
            referencedColumns: ["id"]
          },
        ]
      }
      excel_exports: {
        Row: {
          created_at: string
          file_hash: string | null
          generated_at: string
          generated_by: string
          id: string
          snapshot_id: string
          storage_path: string | null
          template_version: string
          validation_status: string
          weekly_review_id: string
        }
        Insert: {
          created_at?: string
          file_hash?: string | null
          generated_at?: string
          generated_by: string
          id?: string
          snapshot_id: string
          storage_path?: string | null
          template_version: string
          validation_status: string
          weekly_review_id: string
        }
        Update: {
          created_at?: string
          file_hash?: string | null
          generated_at?: string
          generated_by?: string
          id?: string
          snapshot_id?: string
          storage_path?: string | null
          template_version?: string
          validation_status?: string
          weekly_review_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "excel_exports_generated_by_fkey"
            columns: ["generated_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "excel_exports_snapshot_id_fkey"
            columns: ["snapshot_id"]
            isOneToOne: false
            referencedRelation: "weekly_review_snapshots"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "excel_exports_weekly_review_id_fkey"
            columns: ["weekly_review_id"]
            isOneToOne: false
            referencedRelation: "weekly_reviews"
            referencedColumns: ["id"]
          },
        ]
      }
      late_arrival_decisions: {
        Row: {
          created_at: string
          decided_at: string
          decided_by: string
          id: string
          is_current: boolean
          justified: boolean
          late_arrival_record_id: string
          payroll_effect: string
          payroll_minutes: number
          reason: string | null
        }
        Insert: {
          created_at?: string
          decided_at?: string
          decided_by: string
          id?: string
          is_current?: boolean
          justified: boolean
          late_arrival_record_id: string
          payroll_effect: string
          payroll_minutes: number
          reason?: string | null
        }
        Update: {
          created_at?: string
          decided_at?: string
          decided_by?: string
          id?: string
          is_current?: boolean
          justified?: boolean
          late_arrival_record_id?: string
          payroll_effect?: string
          payroll_minutes?: number
          reason?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "late_arrival_decisions_decided_by_fkey"
            columns: ["decided_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "late_arrival_decisions_late_arrival_record_id_fkey"
            columns: ["late_arrival_record_id"]
            isOneToOne: false
            referencedRelation: "late_arrival_records"
            referencedColumns: ["id"]
          },
        ]
      }
      late_arrival_policies: {
        Row: {
          created_at: string
          day_of_week: number
          effective_from: string
          effective_to: string | null
          employee_group_id: string
          id: string
          tolerance_minutes: number
        }
        Insert: {
          created_at?: string
          day_of_week: number
          effective_from: string
          effective_to?: string | null
          employee_group_id: string
          id?: string
          tolerance_minutes?: number
        }
        Update: {
          created_at?: string
          day_of_week?: number
          effective_from?: string
          effective_to?: string | null
          employee_group_id?: string
          id?: string
          tolerance_minutes?: number
        }
        Relationships: [
          {
            foreignKeyName: "late_arrival_policies_employee_group_id_fkey"
            columns: ["employee_group_id"]
            isOneToOne: false
            referencedRelation: "employee_groups"
            referencedColumns: ["id"]
          },
        ]
      }
      late_arrival_records: {
        Row: {
          actual_start: string
          attendance_record_id: string
          calculated_at: string
          calculation_version: number
          created_at: string
          detected_minutes: number
          employee_id: string
          id: string
          is_current: boolean
          late_arrival_policy_id: string
          scheduled_start: string
          work_date: string
        }
        Insert: {
          actual_start: string
          attendance_record_id: string
          calculated_at?: string
          calculation_version?: number
          created_at?: string
          detected_minutes: number
          employee_id: string
          id?: string
          is_current?: boolean
          late_arrival_policy_id: string
          scheduled_start: string
          work_date: string
        }
        Update: {
          actual_start?: string
          attendance_record_id?: string
          calculated_at?: string
          calculation_version?: number
          created_at?: string
          detected_minutes?: number
          employee_id?: string
          id?: string
          is_current?: boolean
          late_arrival_policy_id?: string
          scheduled_start?: string
          work_date?: string
        }
        Relationships: [
          {
            foreignKeyName: "late_arrival_records_attendance_record_id_fkey"
            columns: ["attendance_record_id"]
            isOneToOne: false
            referencedRelation: "attendance_records"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "late_arrival_records_employee_id_fkey"
            columns: ["employee_id"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "late_arrival_records_late_arrival_policy_id_fkey"
            columns: ["late_arrival_policy_id"]
            isOneToOne: false
            referencedRelation: "late_arrival_policies"
            referencedColumns: ["id"]
          },
        ]
      }
      overtime_decisions: {
        Row: {
          approved_minutes: number
          created_at: string
          decided_at: string
          decided_by: string
          decision_status: Database["public"]["Enums"]["overtime_decision_status"]
          id: string
          is_current: boolean
          overtime_record_id: string
          reason: string | null
          rejected_minutes: number
        }
        Insert: {
          approved_minutes: number
          created_at?: string
          decided_at?: string
          decided_by: string
          decision_status: Database["public"]["Enums"]["overtime_decision_status"]
          id?: string
          is_current?: boolean
          overtime_record_id: string
          reason?: string | null
          rejected_minutes: number
        }
        Update: {
          approved_minutes?: number
          created_at?: string
          decided_at?: string
          decided_by?: string
          decision_status?: Database["public"]["Enums"]["overtime_decision_status"]
          id?: string
          is_current?: boolean
          overtime_record_id?: string
          reason?: string | null
          rejected_minutes?: number
        }
        Relationships: [
          {
            foreignKeyName: "overtime_decisions_decided_by_fkey"
            columns: ["decided_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "overtime_decisions_overtime_record_id_fkey"
            columns: ["overtime_record_id"]
            isOneToOne: false
            referencedRelation: "overtime_records"
            referencedColumns: ["id"]
          },
        ]
      }
      overtime_policies: {
        Row: {
          created_at: string
          day_of_week: number
          effective_from: string
          effective_to: string | null
          employee_group_id: string
          id: string
          max_overtime_minutes: number | null
          overtime_eligible: boolean
        }
        Insert: {
          created_at?: string
          day_of_week: number
          effective_from: string
          effective_to?: string | null
          employee_group_id: string
          id?: string
          max_overtime_minutes?: number | null
          overtime_eligible: boolean
        }
        Update: {
          created_at?: string
          day_of_week?: number
          effective_from?: string
          effective_to?: string | null
          employee_group_id?: string
          id?: string
          max_overtime_minutes?: number | null
          overtime_eligible?: boolean
        }
        Relationships: [
          {
            foreignKeyName: "overtime_policies_employee_group_id_fkey"
            columns: ["employee_group_id"]
            isOneToOne: false
            referencedRelation: "employee_groups"
            referencedColumns: ["id"]
          },
        ]
      }
      overtime_records: {
        Row: {
          attendance_record_id: string
          calculated_at: string
          calculation_version: number
          candidate_minutes: number
          created_at: string
          employee_id: string
          id: string
          is_current: boolean
          overtime_policy_id: string
          overtime_type_id: string
          work_date: string
        }
        Insert: {
          attendance_record_id: string
          calculated_at?: string
          calculation_version?: number
          candidate_minutes: number
          created_at?: string
          employee_id: string
          id?: string
          is_current?: boolean
          overtime_policy_id: string
          overtime_type_id: string
          work_date: string
        }
        Update: {
          attendance_record_id?: string
          calculated_at?: string
          calculation_version?: number
          candidate_minutes?: number
          created_at?: string
          employee_id?: string
          id?: string
          is_current?: boolean
          overtime_policy_id?: string
          overtime_type_id?: string
          work_date?: string
        }
        Relationships: [
          {
            foreignKeyName: "overtime_records_attendance_record_id_fkey"
            columns: ["attendance_record_id"]
            isOneToOne: false
            referencedRelation: "attendance_records"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "overtime_records_employee_id_fkey"
            columns: ["employee_id"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "overtime_records_overtime_policy_id_fkey"
            columns: ["overtime_policy_id"]
            isOneToOne: false
            referencedRelation: "overtime_policies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "overtime_records_overtime_type_id_fkey"
            columns: ["overtime_type_id"]
            isOneToOne: false
            referencedRelation: "overtime_types"
            referencedColumns: ["id"]
          },
        ]
      }
      overtime_types: {
        Row: {
          active: boolean
          code: string
          created_at: string
          id: string
          name: string
        }
        Insert: {
          active?: boolean
          code: string
          created_at?: string
          id?: string
          name: string
        }
        Update: {
          active?: boolean
          code?: string
          created_at?: string
          id?: string
          name?: string
        }
        Relationships: []
      }
      profiles: {
        Row: {
          active: boolean
          created_at: string
          display_name: string
          id: string
          role: string
        }
        Insert: {
          active?: boolean
          created_at?: string
          display_name: string
          id?: string
          role: string
        }
        Update: {
          active?: boolean
          created_at?: string
          display_name?: string
          id?: string
          role?: string
        }
        Relationships: []
      }
      schedule_assignments: {
        Row: {
          created_at: string
          effective_from: string
          effective_to: string | null
          employee_id: string
          id: string
          work_schedule_id: string
        }
        Insert: {
          created_at?: string
          effective_from: string
          effective_to?: string | null
          employee_id: string
          id?: string
          work_schedule_id: string
        }
        Update: {
          created_at?: string
          effective_from?: string
          effective_to?: string | null
          employee_id?: string
          id?: string
          work_schedule_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "schedule_assignments_employee_id_fkey"
            columns: ["employee_id"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "schedule_assignments_work_schedule_id_fkey"
            columns: ["work_schedule_id"]
            isOneToOne: false
            referencedRelation: "work_schedules"
            referencedColumns: ["id"]
          },
        ]
      }
      supervisor_assignments: {
        Row: {
          created_at: string
          effective_from: string
          effective_to: string | null
          employee_id: string
          id: string
          source: string
          supervisor_profile_id: string
        }
        Insert: {
          created_at?: string
          effective_from: string
          effective_to?: string | null
          employee_id: string
          id?: string
          source?: string
          supervisor_profile_id: string
        }
        Update: {
          created_at?: string
          effective_from?: string
          effective_to?: string | null
          employee_id?: string
          id?: string
          source?: string
          supervisor_profile_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "supervisor_assignments_employee_id_fkey"
            columns: ["employee_id"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "supervisor_assignments_supervisor_profile_id_fkey"
            columns: ["supervisor_profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      sync_runs: {
        Row: {
          created_at: string
          error_summary: Json | null
          finished_at: string | null
          id: string
          records_conflicted: number
          records_created: number
          records_read: number
          records_updated: number
          started_at: string
          status: Database["public"]["Enums"]["sync_run_status"]
          target_period_end: string | null
          target_period_start: string | null
        }
        Insert: {
          created_at?: string
          error_summary?: Json | null
          finished_at?: string | null
          id?: string
          records_conflicted?: number
          records_created?: number
          records_read?: number
          records_updated?: number
          started_at?: string
          status?: Database["public"]["Enums"]["sync_run_status"]
          target_period_end?: string | null
          target_period_start?: string | null
        }
        Update: {
          created_at?: string
          error_summary?: Json | null
          finished_at?: string | null
          id?: string
          records_conflicted?: number
          records_created?: number
          records_read?: number
          records_updated?: number
          started_at?: string
          status?: Database["public"]["Enums"]["sync_run_status"]
          target_period_end?: string | null
          target_period_start?: string | null
        }
        Relationships: []
      }
      weekly_review_snapshots: {
        Row: {
          created_at: string
          generated_at: string
          generated_by: string
          id: string
          payload: Json
          weekly_review_id: string
        }
        Insert: {
          created_at?: string
          generated_at?: string
          generated_by: string
          id?: string
          payload: Json
          weekly_review_id: string
        }
        Update: {
          created_at?: string
          generated_at?: string
          generated_by?: string
          id?: string
          payload?: Json
          weekly_review_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "weekly_review_snapshots_generated_by_fkey"
            columns: ["generated_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "weekly_review_snapshots_weekly_review_id_fkey"
            columns: ["weekly_review_id"]
            isOneToOne: false
            referencedRelation: "weekly_reviews"
            referencedColumns: ["id"]
          },
        ]
      }
      weekly_reviews: {
        Row: {
          closed_at: string | null
          closed_by: string | null
          created_at: string
          id: string
          period_end: string
          period_start: string
          reopen_reason: string | null
          reopened_at: string | null
          reopened_by: string | null
          status: Database["public"]["Enums"]["weekly_review_status"]
          updated_at: string
        }
        Insert: {
          closed_at?: string | null
          closed_by?: string | null
          created_at?: string
          id?: string
          period_end: string
          period_start: string
          reopen_reason?: string | null
          reopened_at?: string | null
          reopened_by?: string | null
          status?: Database["public"]["Enums"]["weekly_review_status"]
          updated_at?: string
        }
        Update: {
          closed_at?: string | null
          closed_by?: string | null
          created_at?: string
          id?: string
          period_end?: string
          period_start?: string
          reopen_reason?: string | null
          reopened_at?: string | null
          reopened_by?: string | null
          status?: Database["public"]["Enums"]["weekly_review_status"]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "weekly_reviews_closed_by_fkey"
            columns: ["closed_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "weekly_reviews_reopened_by_fkey"
            columns: ["reopened_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      work_schedule_rules: {
        Row: {
          created_at: string
          day_of_week: number
          id: string
          scheduled_end: string | null
          scheduled_start: string | null
          work_schedule_id: string
        }
        Insert: {
          created_at?: string
          day_of_week: number
          id?: string
          scheduled_end?: string | null
          scheduled_start?: string | null
          work_schedule_id: string
        }
        Update: {
          created_at?: string
          day_of_week?: number
          id?: string
          scheduled_end?: string | null
          scheduled_start?: string | null
          work_schedule_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "work_schedule_rules_work_schedule_id_fkey"
            columns: ["work_schedule_id"]
            isOneToOne: false
            referencedRelation: "work_schedules"
            referencedColumns: ["id"]
          },
        ]
      }
      work_schedules: {
        Row: {
          active: boolean
          created_at: string
          id: string
          name: string
        }
        Insert: {
          active?: boolean
          created_at?: string
          id?: string
          name: string
        }
        Update: {
          active?: boolean
          created_at?: string
          id?: string
          name?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      [_ in never]: never
    }
    Enums: {
      daily_review_status:
        | "IMPORTED"
        | "PENDING_REVIEW"
        | "REVIEWED"
        | "NEEDS_REVIEW"
        | "SYNC_CONFLICT"
        | "CORRECTED_AFTER_REVIEW"
        | "READY_FOR_WEEKLY_CLOSE"
      overtime_decision_status:
        | "FULLY_APPROVED"
        | "PARTIALLY_APPROVED"
        | "REJECTED"
      sync_run_status: "RUNNING" | "SUCCEEDED" | "FAILED" | "PARTIAL"
      weekly_review_status: "OPEN" | "READY_TO_CLOSE" | "CLOSED" | "REOPENED"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  graphql_public: {
    Enums: {},
  },
  public: {
    Enums: {
      daily_review_status: [
        "IMPORTED",
        "PENDING_REVIEW",
        "REVIEWED",
        "NEEDS_REVIEW",
        "SYNC_CONFLICT",
        "CORRECTED_AFTER_REVIEW",
        "READY_FOR_WEEKLY_CLOSE",
      ],
      overtime_decision_status: [
        "FULLY_APPROVED",
        "PARTIALLY_APPROVED",
        "REJECTED",
      ],
      sync_run_status: ["RUNNING", "SUCCEEDED", "FAILED", "PARTIAL"],
      weekly_review_status: ["OPEN", "READY_TO_CLOSE", "CLOSED", "REOPENED"],
    },
  },
} as const

