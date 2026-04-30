'use client';

import DashboardLayout from '@/components/layout/DashboardLayout';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Users, Zap } from 'lucide-react';

interface AIWorkforceProps {
  showCrm?: boolean;
  showAiWorkforce?: boolean;
}

export default function AIWorkforce({ showCrm = false, showAiWorkforce = false }: AIWorkforceProps) {
  return (
    <DashboardLayout showCrm={showCrm} showAiWorkforce={showAiWorkforce}>
      <div className="flex flex-col h-full p-6 space-y-6 animate-fade-in">
        {/* Header */}
        <div className="relative flex-shrink-0">
          <div className="absolute -inset-2 rounded-2xl opacity-20 blur-xl transition-colors duration-500 bg-gradient-to-r from-orange-500 via-amber-500 to-yellow-500" />
          <div className="relative flex items-center gap-5">
            <div className="relative group">
              <div className="absolute inset-0 rounded-2xl blur-md opacity-60 group-hover:opacity-80 transition-opacity bg-gradient-to-br from-orange-400 to-amber-600" />
              <div className="relative flex h-14 w-14 items-center justify-center rounded-2xl shadow-xl transition-all duration-300 group-hover:scale-105 bg-gradient-to-br from-orange-500 via-amber-500 to-yellow-600">
                <Users className="h-7 w-7 text-white drop-shadow-lg" />
                <div
                  className="absolute inset-0 rounded-2xl animate-ping opacity-20 bg-orange-400"
                  style={{ animationDuration: '3s' }}
                />
              </div>
            </div>
            <div className="flex-1">
              <div className="flex items-center gap-3 mb-1">
                <h1 className="text-2xl font-bold tracking-tight bg-gradient-to-r from-foreground to-foreground/70 bg-clip-text">
                  AI Workforce
                </h1>
                <Badge
                  variant="outline"
                  className="text-xs font-medium px-2 py-0.5 border-0 bg-orange-500/10 text-orange-600 hover:bg-orange-500/20"
                >
                  <Zap className="h-3 w-3 mr-1" />
                  Coming Soon
                </Badge>
              </div>
              <p className="text-muted-foreground text-sm">
                Manage your AI workforce and automate tasks
              </p>
            </div>
          </div>
        </div>

        {/* Placeholder Content */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Users className="h-5 w-5 text-orange-500" />
              AI Workforce
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-center py-12 text-muted-foreground">
              <div className="mx-auto h-12 w-12 mb-4 opacity-50 flex items-center justify-center text-orange-500">
                <Users className="h-12 w-12" />
              </div>
              <p className="text-lg font-medium">Coming Soon</p>
              <p className="text-sm">This feature is under development.</p>
            </div>
          </CardContent>
        </Card>
      </div>
    </DashboardLayout>
  );
}
